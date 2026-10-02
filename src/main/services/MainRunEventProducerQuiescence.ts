export interface MainRunEventProducer {
  readonly id: string
  /** Ownership must come from the host's registry, not a provider assertion. */
  readonly ownership: 'main' | 'independent-host' | 'unknown'
  /** Includes terminal callbacks and cleanup which can still append events. */
  readonly join: () => Promise<boolean>
}

export interface MainRunEventProducerQuiescencePorts {
  /** Each fence is synchronous, idempotent, and remains raised after failure. */
  readonly fenceAdmissions: () => void
  readonly fenceQueueDispatch: () => void
  readonly fenceNativeActions: () => void
  /** Must include pending audits and every main operation capable of appending. */
  readonly snapshot: () => readonly MainRunEventProducer[]
}

export interface MainRunEventProducerQuiescence {
  /** Raises all fences before returning a promise or observing producers. */
  quiesce(): Promise<void>
}

export function createMainRunEventProducerQuiescence(
  ports: MainRunEventProducerQuiescencePorts
): MainRunEventProducerQuiescence {
  let running: Promise<void> | undefined
  const fences = [ports.fenceAdmissions, ports.fenceQueueDispatch, ports.fenceNativeActions]
  const raised = new Set<number>()
  return {
    quiesce() {
      if (running) return running
      const failures: unknown[] = []
      // Attempt every fence even when an earlier fence throws. No snapshot
      // or join is safe until all three have succeeded.
      for (let index = 0; index < fences.length; index += 1) {
        if (raised.has(index)) continue
        try {
          fences[index]()
          raised.add(index)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) {
        return Promise.reject(new AggregateError(failures, 'Main producer quit fence failed.'))
      }
      let captured: readonly MainRunEventProducer[]
      try {
        captured = [...ports.snapshot()]
      } catch (error) {
        return Promise.reject(error)
      }
      const attempt = async (): Promise<void> => {
        const known = new Set<MainRunEventProducer>()
        let batch = captured
        for (;;) {
          const results = await Promise.allSettled(
            batch.map(async (producer) => {
              known.add(producer)
              if (producer.ownership === 'independent-host') return
              if (producer.ownership !== 'main') {
                throw new Error(`Unknown producer ownership: ${producer.id}`)
              }
              if (!(await producer.join())) throw new Error(`Producer did not join: ${producer.id}`)
            })
          )
          const failed = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          )
          if (failed.length > 0) {
            throw new AggregateError(failed, 'Main run-event producers did not quiesce.')
          }
          // A terminal callback may register another audit while its parent
          // joins. Drain that new operation too. Registry entries must retain
          // object identity until removed; a settled entry may remain visible.
          batch = ports.snapshot().filter((producer) => !known.has(producer))
          if (batch.length === 0) return
        }
      }
      running = attempt().finally(() => {
        running = undefined
      })
      return running
    }
  }
}
