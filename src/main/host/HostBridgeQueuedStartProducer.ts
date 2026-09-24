import type { RunDispatchObserver } from '../run/AgentRunTypes'
import type { ChatRecord, ProviderId } from '../store/types'
import {
  HOST_COMMAND_ACTION_ID_PREFIX,
  isSafeHostIdentifier,
  resolveHostCommandActionId
} from './HostCommandIdentity'
import type {
  createHostBridgeQueuedStartAdapter,
  HostBridgeQueuedStartView
} from './HostBridgeQueuedStartAdapter'

export interface HostBridgeQueuedStartCorrelation {
  readonly hostCommandActionId?: string
  readonly threadId: string
}

export interface HostBridgeQueuedStartIdentity extends HostBridgeQueuedStartCorrelation {
  readonly hostCommandActionId: string
  readonly runId: string
  readonly promptMessageId: string
  readonly provider: ProviderId
}

/** Validate the exact prompt/start linkage; persistence is a separate barrier. */
export function verifyHostBridgeQueuedStartRecord(
  chat: Pick<ChatRecord, 'appChatId' | 'runs' | 'messages'> | null | undefined,
  identity: HostBridgeQueuedStartIdentity
): boolean {
  if (
    !chat ||
    chat.appChatId !== identity.threadId ||
    !isSafeHostIdentifier(identity.runId) ||
    !isSafeHostIdentifier(identity.promptMessageId) ||
    !Array.isArray(chat.runs) ||
    !Array.isArray(chat.messages)
  ) {
    return false
  }
  const runs = chat.runs.filter(
    (run) => run.runId === identity.runId || run.promptMessageId === identity.promptMessageId
  )
  const messages = chat.messages.filter((message) => message.id === identity.promptMessageId)
  if (runs.length !== 1 || messages.length !== 1) return false
  const run = runs[0]
  const message = messages[0]
  return (
    run.runId === identity.runId &&
    run.promptMessageId === identity.promptMessageId &&
    run.provider === identity.provider &&
    typeof run.startedAt === 'string' &&
    Number.isFinite(Date.parse(run.startedAt)) &&
    // A fast turn may already have ended while the journal barrier awaited.
    // The observer proves invocation; this verifier proves the recorded start.
    ['running', 'sleeping', 'success', 'success_with_warnings', 'failed', 'cancelled'].includes(
      run.status ?? ''
    ) &&
    message.role === 'user' &&
    (message.runId === undefined || message.runId === identity.runId)
  )
}

export type HostBridgeQueuedStartProducerAdapter = Pick<
  ReturnType<typeof createHostBridgeQueuedStartAdapter>,
  'get' | 'prepared' | 'settled'
>

export interface HostBridgeQueuedStartProducerOptions {
  readonly persistenceEnabled: () => boolean
  /** Await the journal revision containing this exact prompt and start row. */
  readonly awaitPromptAndStartDurable: (identity: HostBridgeQueuedStartIdentity) => Promise<void>
  /** Verify exact chat/run/user-message linkage before and after the journal barrier. */
  readonly verifyPromptAndStart: (identity: HostBridgeQueuedStartIdentity) => boolean
}

export interface HostBridgeQueuedStartDispatchObservation {
  readonly observer: RunDispatchObserver
  /** A resolved dispatch is an outcome observation, never persistence proof. */
  dispatchSettled(result: { dispatched: boolean; appRunId?: string }): void
  /** A throw may follow provider effects even when the observer never fired. */
  dispatchRejected(): void
}

interface Binding {
  readonly adapter: HostBridgeQueuedStartProducerAdapter
  readonly abortQueuedStart: (commandId: string) => void
}

interface DispatchState {
  readonly identity: HostBridgeQueuedStartIdentity
  readonly binding: Binding
  readonly handle: HostBridgeQueuedStartDispatchObservation
  invoked: boolean
  published: boolean
  abandoned: boolean
  completed: boolean
}

/**
 * Observational solo producer. Binding exists only on the queued-start ON path;
 * absent binding and ordinary Bridge actions are no-ops. This module never
 * dispatches, retries, cancels, or authorizes provider work.
 *
 * Only exact adapter invocation followed by the injected durable journal
 * barrier and exact stored-row verification can emit prepared(true). Early
 * Bridge ACKs and full-turn dispatch completion are insufficient evidence.
 */
export function createHostBridgeQueuedStartProducer(options: HostBridgeQueuedStartProducerOptions) {
  if (
    !options ||
    typeof options.persistenceEnabled !== 'function' ||
    typeof options.awaitPromptAndStartDurable !== 'function' ||
    typeof options.verifyPromptAndStart !== 'function'
  ) {
    throw new Error('HostBridgeQueuedStartProducer requires persistence evidence ports')
  }
  let binding: Binding | undefined
  let shuttingDown = false
  let releaseShutdown!: (result: 'shutdown') => void
  const shutdown = new Promise<'shutdown'>((resolve) => {
    releaseShutdown = resolve
  })
  const states = new Map<string, DispatchState>()
  const aborted = new Set<string>()
  const terminal = new Set<string>()
  const inFlight = new Set<Promise<void>>()

  const track = (operation: Promise<void>): void => {
    const contained = operation.catch(() => undefined)
    inFlight.add(contained)
    void contained.then(() => inFlight.delete(contained))
  }

  const getView = (
    bound: Binding,
    correlation: HostBridgeQueuedStartCorrelation
  ): HostBridgeQueuedStartView | undefined => {
    const actionId = resolveHostCommandActionId(correlation.hostCommandActionId)
    if (!actionId || !isSafeHostIdentifier(correlation.threadId)) return undefined
    try {
      const view = bound.adapter.get(actionId)
      return view?.hostCommandActionId === actionId && view.threadId === correlation.threadId
        ? view
        : undefined
    } catch {
      return undefined
    }
  }

  const matchesRun = (
    view: HostBridgeQueuedStartView,
    identity: HostBridgeQueuedStartIdentity
  ): boolean =>
    (!view.queued || view.queued.reservedRunId === identity.runId) &&
    (!view.prepared ||
      (view.prepared.start.kind === 'solo' && view.prepared.start.runId === identity.runId))

  const hasPrepared = (
    view: HostBridgeQueuedStartView | undefined,
    identity: HostBridgeQueuedStartIdentity
  ): boolean =>
    Boolean(
      view &&
      (view.phase === 'prepared' || view.phase === 'settled') &&
      matchesRun(view, identity) &&
      view.prepared?.start.kind === 'solo' &&
      view.prepared.start.runId === identity.runId
    )

  const abortOnce = (bound: Binding, actionId: string): void => {
    if (aborted.has(actionId)) return
    aborted.add(actionId)
    try {
      bound.abortQueuedStart(actionId.slice(HOST_COMMAND_ACTION_ID_PREFIX.length))
    } catch {
      // The port may have mutated before throwing. Never retry or turn an
      // unknown outcome into a false failed settlement.
    }
  }

  const abandon = (state: DispatchState): void => {
    if (state.published || state.abandoned) return
    state.abandoned = true
    const view = getView(state.binding, state.identity)
    if (hasPrepared(view, state.identity)) return
    abortOnce(state.binding, state.identity.hostCommandActionId)
  }

  const unproven = (correlation: HostBridgeQueuedStartCorrelation): void => {
    if (!binding) return
    const view = getView(binding, correlation)
    if (!view) return
    const state = states.get(view.hostCommandActionId)
    if (state) {
      abandon(state)
      return
    }
    if (view.phase === 'prepared' || view.phase === 'settled') return
    abortOnce(binding, view.hostCommandActionId)
  }

  const settleKnownNoDispatch = (
    bound: Binding,
    correlation: HostBridgeQueuedStartCorrelation,
    status: 'failed' | 'cancelled'
  ): void => {
    if (shuttingDown) {
      unproven(correlation)
      return
    }
    const view = getView(bound, correlation)
    if (!view || terminal.has(view.hostCommandActionId) || aborted.has(view.hostCommandActionId)) {
      return
    }
    const state = states.get(view.hostCommandActionId)
    if (state?.invoked) {
      abandon(state)
      return
    }
    if (state?.abandoned || view.phase === 'prepared' || view.phase === 'settled') return
    terminal.add(view.hostCommandActionId)
    if (state) state.completed = true
    track(
      (async () => {
        try {
          const result = await bound.adapter.settled({
            kind: 'settled',
            hostCommandActionId: view.hostCommandActionId,
            threadId: view.threadId,
            status,
            errorCode: status === 'cancelled' ? 'queued_prompt_cancelled' : 'dispatch_declined'
          })
          if (
            (result.kind === 'applied' || result.kind === 'unchanged') &&
            result.view.hostCommandActionId === view.hostCommandActionId &&
            result.view.threadId === view.threadId &&
            result.view.phase === 'settled' &&
            result.view.settled?.status === status &&
            !result.view.prepared
          ) {
            // The terminal fence and adapter retain this outcome. Retire the
            // observation so shutdown cannot abandon a confirmed rejection;
            // its completed handle still ignores late provider callbacks.
            if (state && states.get(view.hostCommandActionId) === state) {
              states.delete(view.hostCommandActionId)
            }
            return
          }
        } catch {
          // Refusal and throw both abandon proof; neither proves a failure.
        }
        abortOnce(bound, view.hostCommandActionId)
      })()
    )
  }

  const publishPrepared = async (state: DispatchState): Promise<void> => {
    try {
      if (state.abandoned || shuttingDown) return abandon(state)
      // Verify synchronously before capturing the journal barrier. A row
      // which appears only after that barrier may belong to a newer revision.
      if (
        options.persistenceEnabled() !== true ||
        options.verifyPromptAndStart(state.identity) !== true
      ) {
        return abandon(state)
      }
      const durability = options.awaitPromptAndStartDurable(state.identity).then(
        () => 'durable' as const,
        () => 'failed' as const
      )
      // The journal can be waiting on a catalogue gate indefinitely. Shutdown
      // abandons proof and releases our tail; the detached barrier is rejection
      // contained and has no continuation capable of publishing late evidence.
      if ((await Promise.race([durability, shutdown])) !== 'durable') return abandon(state)
      if (state.abandoned || shuttingDown) return abandon(state)
      const view = getView(state.binding, state.identity)
      if (!view || !matchesRun(view, state.identity)) return abandon(state)
      if (hasPrepared(view, state.identity)) {
        state.published = true
        return
      }
      if (
        view.phase === 'settled' ||
        options.persistenceEnabled() !== true ||
        options.verifyPromptAndStart(state.identity) !== true
      ) {
        return abandon(state)
      }
      const result = await state.binding.adapter.prepared({
        kind: 'prepared',
        hostCommandActionId: state.identity.hostCommandActionId,
        threadId: state.identity.threadId,
        durablePromptAndStartPersisted: true,
        start: { kind: 'solo', runId: state.identity.runId },
        effectRefs: [
          { family: 'thread', entityId: state.identity.threadId },
          { family: 'run', entityId: state.identity.runId }
        ]
      })
      if (
        ((result.kind === 'applied' || result.kind === 'unchanged') &&
          result.view.hostCommandActionId === state.identity.hostCommandActionId &&
          result.view.threadId === state.identity.threadId &&
          hasPrepared(result.view, state.identity)) ||
        hasPrepared(getView(state.binding, state.identity), state.identity)
      ) {
        state.published = true
        return
      }
      abandon(state)
    } catch {
      abandon(state)
    }
  }

  return {
    onAdapter(
      adapter: HostBridgeQueuedStartProducerAdapter,
      abortQueuedStart: Binding['abortQueuedStart']
    ): void {
      if (
        !adapter ||
        typeof adapter.get !== 'function' ||
        typeof adapter.prepared !== 'function' ||
        typeof adapter.settled !== 'function' ||
        typeof abortQueuedStart !== 'function'
      ) {
        throw new Error('HostBridgeQueuedStartProducer requires adapter and abort ports')
      }
      if (binding && binding.adapter !== adapter) {
        throw new Error('HostBridgeQueuedStartProducer is already bound')
      }
      binding = { adapter, abortQueuedStart }
    },

    observeDispatch(
      input: Omit<HostBridgeQueuedStartIdentity, 'hostCommandActionId'> &
        HostBridgeQueuedStartCorrelation
    ): HostBridgeQueuedStartDispatchObservation | undefined {
      if (!binding) return undefined
      const view = getView(binding, input)
      if (!view) return undefined
      if (
        shuttingDown ||
        !isSafeHostIdentifier(input.runId) ||
        !isSafeHostIdentifier(input.promptMessageId)
      ) {
        unproven(input)
        return undefined
      }
      const identity: HostBridgeQueuedStartIdentity = Object.freeze({
        hostCommandActionId: view.hostCommandActionId,
        threadId: input.threadId,
        runId: input.runId,
        promptMessageId: input.promptMessageId,
        provider: input.provider
      })
      if (!matchesRun(view, identity)) {
        unproven(input)
        return undefined
      }
      const existing = states.get(view.hostCommandActionId)
      if (existing) {
        if (
          existing.identity.runId === identity.runId &&
          existing.identity.promptMessageId === identity.promptMessageId &&
          existing.identity.provider === identity.provider
        ) {
          return existing.handle
        }
        abandon(existing)
        return undefined
      }
      if (aborted.has(view.hostCommandActionId) || terminal.has(view.hostCommandActionId)) {
        return undefined
      }
      if (view.phase === 'prepared' || view.phase === 'settled') return undefined
      const handle: HostBridgeQueuedStartDispatchObservation = {
        observer: {
          onAdapterInvoked(receipt) {
            if (state.invoked || state.completed || state.abandoned) return
            state.invoked = true
            if (receipt.appRunId !== identity.runId || receipt.provider !== identity.provider) {
              abandon(state)
              return
            }
            track(publishPrepared(state))
          }
        },
        dispatchSettled(result) {
          if (state.completed || state.abandoned) return
          state.completed = true
          if (result.appRunId !== identity.runId) {
            abandon(state)
          } else if (!state.invoked && result.dispatched === false) {
            settleKnownNoDispatch(state.binding, identity, 'failed')
          } else if (result.dispatched !== true || !state.invoked) {
            abandon(state)
          }
        },
        dispatchRejected() {
          if (state.completed) return
          state.completed = true
          abandon(state)
        }
      }
      const state: DispatchState = {
        identity,
        binding,
        handle,
        invoked: false,
        published: false,
        abandoned: false,
        completed: false
      }
      states.set(view.hostCommandActionId, state)
      return handle
    },

    /** Call only after a main-owned queue cancellation proved no dispatch occurred. */
    queueCancelled(correlation: HostBridgeQueuedStartCorrelation): void {
      if (binding) settleKnownNoDispatch(binding, correlation, 'cancelled')
    },

    /** Call only when main proved the queued prompt was rejected before dispatch. */
    queueDeclined(correlation: HostBridgeQueuedStartCorrelation): void {
      if (binding) settleKnownNoDispatch(binding, correlation, 'failed')
    },

    unproven,

    beginShutdown(): void {
      shuttingDown = true
      releaseShutdown('shutdown')
      for (const state of states.values()) abandon(state)
    },

    async drain(): Promise<void> {
      // The dispatch promise can cover an entire provider turn. Drain only
      // evidence publication tails; late provider callbacks remain fenced.
      while (inFlight.size > 0) await Promise.all([...inFlight])
    }
  }
}
