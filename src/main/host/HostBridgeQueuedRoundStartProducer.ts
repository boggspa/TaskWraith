import type { EnsembleRoundStartObserver } from '../services/EnsembleRoundStartObserver'
import type { ChatRecord } from '../store/types'
import {
  HOST_COMMAND_ACTION_ID_PREFIX,
  isSafeHostIdentifier,
  resolveHostCommandActionId
} from './HostCommandIdentity'
import type {
  createHostBridgeQueuedStartAdapter,
  HostBridgeQueuedStartView
} from './HostBridgeQueuedStartAdapter'

export interface HostBridgeQueuedRoundStartCorrelation {
  readonly hostCommandActionId?: string
  readonly threadId: string
}

export interface HostBridgeQueuedRoundStartIdentity extends HostBridgeQueuedRoundStartCorrelation {
  readonly hostCommandActionId: string
  readonly roundId: string
}

/** Verify a new round's exact user prompt; durability is a separate barrier. */
export function verifyHostBridgeQueuedRoundStartRecord(
  chat: Pick<ChatRecord, 'appChatId' | 'ensemble' | 'messages'> | null | undefined,
  identity: HostBridgeQueuedRoundStartIdentity
): boolean {
  if (
    !chat ||
    chat.appChatId !== identity.threadId ||
    !resolveHostCommandActionId(identity.hostCommandActionId) ||
    !isSafeHostIdentifier(identity.threadId) ||
    !isSafeHostIdentifier(identity.roundId) ||
    !Array.isArray(chat.messages) ||
    chat.ensemble?.enabled !== true
  ) {
    return false
  }
  const round = chat.ensemble.activeRound
  if (
    !round ||
    round.roundId !== identity.roundId ||
    round.status !== 'running' ||
    round.endedAt !== undefined ||
    typeof round.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(round.startedAt))
  ) {
    return false
  }
  const promptId = `ensemble-user-${identity.roundId}`
  const messages = chat.messages.filter(
    (message) =>
      message.id === promptId ||
      (message.metadata?.kind === 'ensembleRoundPrompt' &&
        message.metadata.ensembleRoundId === identity.roundId)
  )
  if (messages.length !== 1) return false
  const message = messages[0]
  return (
    message.id === promptId &&
    message.role === 'user' &&
    message.metadata?.kind === 'ensembleRoundPrompt' &&
    message.metadata.ensembleRoundId === identity.roundId &&
    message.content === round.prompt &&
    message.timestamp === round.startedAt
  )
}

export type HostBridgeQueuedRoundStartProducerAdapter = Pick<
  ReturnType<typeof createHostBridgeQueuedStartAdapter>,
  'get' | 'prepared'
>

export interface HostBridgeQueuedRoundStartProducerOptions {
  readonly persistenceEnabled: () => boolean
  /** Called synchronously at reservation to capture that journal revision. */
  readonly awaitPromptAndRoundDurable: (
    identity: HostBridgeQueuedRoundStartIdentity
  ) => Promise<void>
  /** Verify the exact saved round and user prompt before and after the barrier. */
  readonly verifyPromptAndRound: (identity: HostBridgeQueuedRoundStartIdentity) => boolean
}

export interface HostBridgeQueuedRoundStartObservation {
  readonly observer: EnsembleRoundStartObserver
  /** A started result confirms correlation only; it is never durable proof. */
  dispatchSettled(result: { status?: string; roundId?: string }): void
  /** Throws can follow side effects, including before reservation is observed. */
  dispatchRejected(): void
}

/** Preserve the synchronous round result while observing its outcome. */
export function dispatchObservedHostBridgeRound<
  Result extends { status?: string; roundId?: string } | undefined
>(
  observation: HostBridgeQueuedRoundStartObservation | undefined,
  dispatch: (observer: EnsembleRoundStartObserver | undefined) => Result
): Result {
  try {
    const result = dispatch(observation?.observer)
    observation?.dispatchSettled(result ?? {})
    return result
  } catch (error) {
    observation?.dispatchRejected()
    throw error
  }
}

interface Binding {
  readonly adapter: HostBridgeQueuedRoundStartProducerAdapter
  readonly abortQueuedStart: (commandId: string) => void
}

interface RoundState {
  readonly correlation: HostBridgeQueuedRoundStartCorrelation & {
    readonly hostCommandActionId: string
  }
  readonly binding: Binding
  readonly handle: HostBridgeQueuedRoundStartObservation
  readonly abandonment: Promise<'abandoned'>
  readonly releaseAbandonment: () => void
  identity?: HostBridgeQueuedRoundStartIdentity
  durability?: Promise<'durable' | 'failed'>
  evidence?: Promise<void>
  published: boolean
  abandoned: boolean
  completed: boolean
}

/**
 * Observational round producer, bound only on the queued-start ON path. It
 * never dispatches or retries participants. Reservation captures the journal
 * barrier; only the orchestrator's fenced before-participants callback may
 * publish that proof. Early Bridge ACKs and provider outcomes cannot do so.
 *
 * Uncertain execution only abandons proof. A throwing abort port may already
 * have mutated; never retry it or claim failure. If it failed before mutation,
 * the receipt can remain pending until shutdown/restart marks it indeterminate.
 */
export function createHostBridgeQueuedRoundStartProducer(
  options: HostBridgeQueuedRoundStartProducerOptions
) {
  if (
    !options ||
    typeof options.persistenceEnabled !== 'function' ||
    typeof options.awaitPromptAndRoundDurable !== 'function' ||
    typeof options.verifyPromptAndRound !== 'function'
  ) {
    throw new Error('HostBridgeQueuedRoundStartProducer requires persistence evidence ports')
  }
  let binding: Binding | undefined
  let shuttingDown = false
  let releaseShutdown!: (result: 'shutdown') => void
  const shutdown = new Promise<'shutdown'>((resolve) => {
    releaseShutdown = resolve
  })
  const states = new Map<string, RoundState>()
  const aborted = new Set<string>()
  const inFlight = new Set<Promise<void>>()

  const track = (operation: Promise<void>): Promise<void> => {
    const contained = operation.catch(() => undefined)
    inFlight.add(contained)
    void contained.then(() => inFlight.delete(contained))
    return contained
  }

  const getView = (
    bound: Binding,
    correlation: HostBridgeQueuedRoundStartCorrelation
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

  const hasPrepared = (
    view: HostBridgeQueuedStartView | undefined,
    identity: HostBridgeQueuedRoundStartIdentity | undefined
  ): boolean =>
    Boolean(
      identity &&
      view &&
      view.hostCommandActionId === identity.hostCommandActionId &&
      view.threadId === identity.threadId &&
      (view.phase === 'prepared' || view.phase === 'settled') &&
      view.prepared?.start.kind === 'ensemble' &&
      view.prepared.start.roundId === identity.roundId
    )

  const abortOnce = (bound: Binding, actionId: string): void => {
    if (aborted.has(actionId)) return
    aborted.add(actionId)
    try {
      bound.abortQueuedStart(actionId.slice(HOST_COMMAND_ACTION_ID_PREFIX.length))
    } catch {
      // Void abort can mutate and then throw. No retry or false failed result.
    }
  }

  const hasKnownNoStart = (view: HostBridgeQueuedStartView | undefined): boolean =>
    Boolean(
      view?.phase === 'settled' &&
      !view.prepared &&
      (view.settled?.status === 'failed' || view.settled?.status === 'cancelled') &&
      view.settled.errorCode !== 'publication_failed'
    )

  const abandon = (state: RoundState): void => {
    if (state.published || state.abandoned) return
    state.abandoned = true
    state.releaseAbandonment()
    const view = getView(state.binding, state.correlation)
    // Adapter callback failure also uses an internal settled/failed marker.
    // That invalidation is not an authoritative known-no-start settlement.
    if (hasPrepared(view, state.identity) || hasKnownNoStart(view)) return
    abortOnce(state.binding, state.correlation.hostCommandActionId)
  }

  const unproven = (correlation: HostBridgeQueuedRoundStartCorrelation): void => {
    if (!binding) return
    const view = getView(binding, correlation)
    if (!view) return
    const state = states.get(view.hostCommandActionId)
    if (state) return abandon(state)
    if (view.prepared || hasKnownNoStart(view)) return
    abortOnce(binding, view.hostCommandActionId)
  }

  const reserve = (state: RoundState, roundId: string): void => {
    if (state.abandoned || state.published) return
    if (shuttingDown || !isSafeHostIdentifier(roundId)) return abandon(state)
    if (state.identity) {
      if (state.identity.roundId !== roundId) abandon(state)
      return
    }
    const identity: HostBridgeQueuedRoundStartIdentity = Object.freeze({
      ...state.correlation,
      roundId
    })
    state.identity = identity
    try {
      const view = getView(state.binding, identity)
      if (!view) return abandon(state)
      if (hasPrepared(view, identity)) {
        state.published = true
        return
      }
      if (
        view.phase === 'prepared' ||
        view.phase === 'settled' ||
        options.persistenceEnabled() !== true ||
        options.verifyPromptAndRound(identity) !== true ||
        state.abandoned ||
        shuttingDown
      ) {
        return abandon(state)
      }
      // Do not defer this call to the detached dispatch task: it must capture
      // the barrier for the saved row which the synchronous verifier just saw.
      state.durability = Promise.resolve(options.awaitPromptAndRoundDurable(identity)).then(
        () => 'durable' as const,
        () => {
          abandon(state)
          return 'failed' as const
        }
      )
    } catch {
      abandon(state)
    }
  }

  const publishPrepared = async (state: RoundState): Promise<void> => {
    try {
      const { identity, durability } = state
      if (!identity || !durability || state.abandoned || shuttingDown) return abandon(state)
      // Shutdown releases an unresolved journal/catalogue gate. Its detached
      // rejection is contained and cannot publish when it eventually resolves.
      if ((await Promise.race([durability, shutdown, state.abandonment])) !== 'durable') {
        return abandon(state)
      }
      if (state.abandoned || shuttingDown) return abandon(state)
      const view = getView(state.binding, identity)
      if (!view) return abandon(state)
      if (hasPrepared(view, identity)) {
        state.published = true
        return
      }
      if (
        view.phase === 'prepared' ||
        view.phase === 'settled' ||
        options.persistenceEnabled() !== true ||
        options.verifyPromptAndRound(identity) !== true ||
        state.abandoned ||
        shuttingDown
      ) {
        return abandon(state)
      }
      const result = await state.binding.adapter.prepared({
        kind: 'prepared',
        hostCommandActionId: identity.hostCommandActionId,
        threadId: identity.threadId,
        durablePromptAndStartPersisted: true,
        start: { kind: 'ensemble', roundId: identity.roundId, participantRunIds: [] },
        effectRefs: [
          { family: 'thread', entityId: identity.threadId },
          { family: 'round', entityId: identity.roundId }
        ]
      })
      if (
        ((result.kind === 'applied' || result.kind === 'unchanged') &&
          hasPrepared(result.view, identity)) ||
        hasPrepared(getView(state.binding, identity), identity)
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
      adapter: HostBridgeQueuedRoundStartProducerAdapter,
      abortQueuedStart: Binding['abortQueuedStart']
    ): void {
      if (
        !adapter ||
        typeof adapter.get !== 'function' ||
        typeof adapter.prepared !== 'function' ||
        typeof abortQueuedStart !== 'function'
      ) {
        throw new Error('HostBridgeQueuedRoundStartProducer requires adapter and abort ports')
      }
      if (binding && binding.adapter !== adapter) {
        throw new Error('HostBridgeQueuedRoundStartProducer is already bound')
      }
      binding = { adapter, abortQueuedStart }
    },

    observeRound(
      input: HostBridgeQueuedRoundStartCorrelation
    ): HostBridgeQueuedRoundStartObservation | undefined {
      if (!binding) return undefined
      const view = getView(binding, input)
      if (!view) return undefined
      if (shuttingDown) {
        unproven(input)
        return undefined
      }
      const existing = states.get(view.hostCommandActionId)
      if (existing) return existing.abandoned ? undefined : existing.handle
      if (
        aborted.has(view.hostCommandActionId) ||
        view.phase === 'prepared' ||
        view.phase === 'settled'
      ) {
        if (view.settled?.errorCode === 'publication_failed') unproven(input)
        return undefined
      }
      const correlation = Object.freeze({
        hostCommandActionId: view.hostCommandActionId,
        threadId: input.threadId
      })
      let releaseAbandonment!: () => void
      const abandonment = new Promise<'abandoned'>((resolve) => {
        releaseAbandonment = () => resolve('abandoned')
      })
      const handle: HostBridgeQueuedRoundStartObservation = {
        observer: {
          onRoundReserved(roundId) {
            reserve(state, roundId)
          },
          onRoundPersistedBeforeParticipants(roundId) {
            if (state.identity?.roundId !== roundId) abandon(state)
            if (state.evidence) return state.evidence
            if (state.abandoned || state.published) return Promise.resolve()
            state.evidence = track(publishPrepared(state))
            return state.evidence
          },
          onRoundStartUnproven() {
            abandon(state)
          }
        },
        dispatchSettled(result) {
          if (state.completed || state.abandoned) return
          state.completed = true
          if (
            result.status !== 'started' ||
            !state.identity ||
            result.roundId !== state.identity.roundId
          ) {
            abandon(state)
          }
        },
        dispatchRejected() {
          if (state.completed) return
          state.completed = true
          abandon(state)
        }
      }
      const state: RoundState = {
        correlation,
        binding,
        handle,
        abandonment,
        releaseAbandonment,
        published: false,
        abandoned: false,
        completed: false
      }
      states.set(view.hostCommandActionId, state)
      return handle
    },

    unproven,

    beginShutdown(): void {
      shuttingDown = true
      releaseShutdown('shutdown')
      for (const state of states.values()) abandon(state)
    },

    async drain(): Promise<void> {
      // No dispatch promises or participant turns are owned by this producer.
      while (inFlight.size > 0) await Promise.all([...inFlight])
    }
  }
}
