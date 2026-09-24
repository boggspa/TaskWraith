/** Observes a newly saved round without owning participant dispatch. */
export interface EnsembleRoundStartObserver {
  onRoundReserved(roundId: string): void
  onRoundPersistedBeforeParticipants(roundId: string): Promise<void>
  onRoundStartUnproven(roundId: string): void
}

export interface EnsembleRoundStartObservation {
  reserved(): void
  beforeParticipants(): Promise<void>
  unproven(): void
}

const absentObservation: EnsembleRoundStartObservation = {
  reserved() {},
  async beforeParticipants() {},
  unproven() {}
}

// Continuations may ask for the same observation again. Its lifetime follows
// the observer, so an unreachable command does not leave a global round entry.
const observations = new WeakMap<
  EnsembleRoundStartObserver,
  Map<string, EnsembleRoundStartObservation>
>()

/** Contain observer faults so they cannot fail ordinary participant work. */
export function createEnsembleRoundStartObservation(
  observer: EnsembleRoundStartObserver | undefined,
  roundId: string
): EnsembleRoundStartObservation {
  if (!observer) return absentObservation
  let rounds = observations.get(observer)
  if (!rounds) {
    rounds = new Map()
    observations.set(observer, rounds)
  }
  const existing = rounds.get(roundId)
  if (existing) return existing

  let reserved = false
  let unproven = false
  let beforeParticipants: Promise<void> | undefined
  const abandon = (): void => {
    if (unproven) return
    unproven = true
    try {
      observer.onRoundStartUnproven(roundId)
    } catch {
      // Observation failure cannot take ownership of provider execution.
    }
  }
  const observation: EnsembleRoundStartObservation = {
    reserved() {
      if (reserved || unproven) return
      reserved = true
      try {
        // This must remain synchronous: the observer captures the exact
        // journal revision immediately after the round and prompt are saved.
        observer.onRoundReserved(roundId)
      } catch {
        abandon()
      }
    },
    beforeParticipants() {
      if (beforeParticipants) return beforeParticipants
      beforeParticipants = Promise.resolve().then(async () => {
        if (unproven) return
        if (!reserved) return abandon()
        try {
          await observer.onRoundPersistedBeforeParticipants(roundId)
        } catch {
          abandon()
        }
      })
      return beforeParticipants
    },
    unproven: abandon
  }
  rounds.set(roundId, observation)
  return observation
}
