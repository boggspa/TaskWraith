import type { MainRunEventProducer } from './MainRunEventProducerQuiescence'
import { createMainRunEventProducerQuiescence } from './MainRunEventProducerQuiescence'

/** Identity belongs to the actual operation generation, never just its run id. */
export class MainQuitProducerRegistry {
  private readonly entries = new WeakMap<Promise<void>, MainRunEventProducer>()

  capture(
    id: string,
    operation: Promise<void>,
    join: () => Promise<boolean>
  ): MainRunEventProducer {
    let entry = this.entries.get(operation)
    if (!entry) {
      entry = { id, ownership: 'main', join }
      this.entries.set(operation, entry)
    }
    return entry
  }
}

export class MainQuitSessionRegistry {
  private readonly entries = new WeakMap<object, MainRunEventProducer>()
  private readonly unresolved = new Set<MainRunEventProducer>()

  capture(
    session: object,
    id: string,
    ownership: MainRunEventProducer['ownership'],
    join: () => Promise<boolean>
  ): MainRunEventProducer {
    let entry = this.entries.get(session)
    if (!entry || entry.ownership !== ownership) {
      if (entry) this.unresolved.delete(entry)
      entry = {
        id,
        ownership,
        join: async () => {
          const settled = await join()
          if (settled) this.unresolved.delete(entry!)
          return settled
        }
      }
      this.entries.set(session, entry)
      if (ownership !== 'independent-host') this.unresolved.add(entry)
    }
    return entry
  }

  pending(): readonly MainRunEventProducer[] {
    return [...this.unresolved]
  }
}

export function createMainQuitProducerBarrier(ports: {
  fenceAdmissions(): Promise<void>
  fenceQueue(): void
  fenceNative(): void
  joinNative(): Promise<void>
  operations(): Array<[string, Promise<void>]>
  joinOperation(runId: string, operation: Promise<void>): Promise<boolean>
  sessions?(): readonly MainRunEventProducer[]
}) {
  const registry = new MainQuitProducerRegistry()
  let admissions: Promise<void> | undefined
  let native: Promise<void> | undefined
  const refreshJoins = (): void => {
    if (!admissions) {
      const attempt = ports.fenceAdmissions()
      admissions = attempt
      void attempt.catch(() => {
        if (admissions === attempt) admissions = undefined
      })
    }
    if (!native) {
      const attempt = ports.joinNative()
      native = attempt
      void attempt.catch(() => {
        if (native === attempt) native = undefined
      })
    }
  }
  return createMainRunEventProducerQuiescence({
    fenceAdmissions: () => {
      const attempt = ports.fenceAdmissions()
      admissions = attempt
      void attempt.catch(() => {
        if (admissions === attempt) admissions = undefined
      })
    },
    fenceQueueDispatch: ports.fenceQueue,
    fenceNativeActions: () => {
      ports.fenceNative()
    },
    snapshot: () => {
      refreshJoins()
      return [
        ...(
          [
            ['admissions', admissions],
            ['native-audits', native]
          ] as const
        ).flatMap(([id, operation]) =>
          operation
            ? [
                registry.capture(id, operation, async () => {
                  await operation
                  return true
                })
              ]
            : []
        ),
        ...ports
          .operations()
          .map(([id, operation]) =>
            registry.capture(id, operation, () => ports.joinOperation(id, operation))
          ),
        ...(ports.sessions?.() ?? [])
      ]
    }
  })
}
