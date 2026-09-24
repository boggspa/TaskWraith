import {
  createHostBridgeQueuedStartProducer,
  type HostBridgeQueuedStartProducerOptions
} from './HostBridgeQueuedStartProducer'
import type {
  HostProductionQueuedStartAdapter,
  HostProductionQueuedStartOptions
} from './HostProductionBootstrap'

type Producer = ReturnType<typeof createHostBridgeQueuedStartProducer>

export interface HostBridgeQueuedStartProducerBindingOptions extends HostBridgeQueuedStartProducerOptions {
  readonly onCurrentProducer: (producer: Producer | null) => void
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
  const producers = new WeakMap<HostProductionQueuedStartAdapter, Producer>()
  const boundAdapters = new WeakSet<HostProductionQueuedStartAdapter>()
  let currentProducer: Producer | null = null

  return {
    onAdapter(adapter, abortQueuedStart) {
      // Bootstrap supplies a fresh adapter once per composition. Replacing a
      // producer for an existing adapter would strand its pending evidence.
      if (boundAdapters.has(adapter)) {
        throw new Error('HostBridgeQueuedStartProducerBinding adapter is already bound')
      }
      const producer = createHostBridgeQueuedStartProducer(options)
      producer.onAdapter(adapter, abortQueuedStart)
      boundAdapters.add(adapter)
      producers.set(adapter, producer)
      currentProducer = producer
      options.onCurrentProducer(producer)
    },
    async beforeShutdown(adapter) {
      const producer = producers.get(adapter)
      if (!producer) return
      // Fence synchronously: stopSync may return and start the next generation
      // while this producer still has publication tails to drain.
      producer.beginShutdown()
      if (currentProducer === producer) {
        currentProducer = null
        options.onCurrentProducer(null)
      }
      await producer.drain()
      producers.delete(adapter)
    }
  }
}
