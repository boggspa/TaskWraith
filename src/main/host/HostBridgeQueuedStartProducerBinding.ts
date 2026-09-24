import {
  createHostBridgeQueuedStartProducer,
  type HostBridgeQueuedStartProducerOptions
} from './HostBridgeQueuedStartProducer'
import {
  createHostBridgeQueuedRoundStartProducer,
  type HostBridgeQueuedRoundStartProducerOptions
} from './HostBridgeQueuedRoundStartProducer'
import type {
  HostProductionQueuedStartAdapter,
  HostProductionQueuedStartOptions
} from './HostProductionBootstrap'

type Producer = ReturnType<typeof createHostBridgeQueuedStartProducer>
type RoundProducer = ReturnType<typeof createHostBridgeQueuedRoundStartProducer>
interface Generation {
  readonly producer: Producer
  readonly roundProducer?: RoundProducer
}

export interface HostBridgeQueuedStartProducerBindingOptions extends HostBridgeQueuedStartProducerOptions {
  readonly onCurrentProducer: (producer: Producer | null) => void
  readonly roundStart?: HostBridgeQueuedRoundStartProducerOptions & {
    readonly onCurrentProducer: (producer: RoundProducer | null) => void
  }
}

/**
 * Owns one producer per composition. Retain this binding across Host restarts
 * that share onCurrentProducer; create only on the queued-start ON path.
 */
export function createHostBridgeQueuedStartProducerBinding(
  options: HostBridgeQueuedStartProducerBindingOptions
): HostProductionQueuedStartOptions {
  if (!options || typeof options.onCurrentProducer !== 'function') {
    throw new Error('HostBridgeQueuedStartProducerBinding requires onCurrentProducer')
  }
  if (options.roundStart && typeof options.roundStart.onCurrentProducer !== 'function') {
    throw new Error('HostBridgeQueuedStartProducerBinding requires round onCurrentProducer')
  }
  const producers = new WeakMap<HostProductionQueuedStartAdapter, Generation>()
  const boundAdapters = new WeakSet<HostProductionQueuedStartAdapter>()
  let currentGeneration: Generation | null = null

  return {
    onAdapter(adapter, abortQueuedStart) {
      // Bootstrap supplies a fresh adapter once per composition. Replacing a
      // producer for an existing adapter would strand its pending evidence.
      if (boundAdapters.has(adapter)) {
        throw new Error('HostBridgeQueuedStartProducerBinding adapter is already bound')
      }
      const producer = createHostBridgeQueuedStartProducer(options)
      const roundProducer = options.roundStart
        ? createHostBridgeQueuedRoundStartProducer(options.roundStart)
        : undefined
      producer.onAdapter(adapter, abortQueuedStart)
      roundProducer?.onAdapter(adapter, abortQueuedStart)
      boundAdapters.add(adapter)
      const generation = { producer, roundProducer }
      producers.set(adapter, generation)
      currentGeneration = generation
      options.onCurrentProducer(producer)
      if (roundProducer) options.roundStart?.onCurrentProducer(roundProducer)
    },
    async beforeShutdown(adapter) {
      const generation = producers.get(adapter)
      if (!generation) return
      // Fence synchronously: stopSync may return and start the next generation
      // while this producer still has publication tails to drain.
      generation.producer.beginShutdown()
      generation.roundProducer?.beginShutdown()
      if (currentGeneration === generation) {
        currentGeneration = null
        options.onCurrentProducer(null)
        options.roundStart?.onCurrentProducer(null)
      }
      await Promise.all([generation.producer.drain(), generation.roundProducer?.drain()])
      producers.delete(adapter)
    }
  }
}
