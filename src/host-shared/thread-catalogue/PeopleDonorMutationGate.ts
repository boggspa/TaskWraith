import { realpathSync } from 'node:fs'
import { readPeopleMigrationLease } from './PeopleMigrationHelperLease'
import { changesLegacyPeopleDonors, type LegacyDonorChat } from '../../shared/legacyPeopleDonors'

const active = new Map<string, Promise<void>>()

/** Extends through the parent cache/admission handoff, not merely child exit. */
export async function withPeopleDonorMutationGate<T>(
  profilePath: string,
  work: () => Promise<T>
): Promise<T> {
  const key = realpathSync(profilePath)
  if (active.has(key)) throw new Error('Collaboration migration is already running')
  let release!: () => void
  active.set(
    key,
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  try {
    return await work()
  } finally {
    active.delete(key)
    release()
  }
}

export function pendingPeopleDonorMutation(profilePath: string): Promise<void> | undefined {
  if (!active.size) return undefined
  return active.get(realpathSync(profilePath))
}

/** Backstop for synchronous/internal writers; user edit handlers await the same owner. */
export function peopleDonorMutationOwned(profilePath: string): boolean {
  let owned = Boolean(pendingPeopleDonorMutation(profilePath))
  if (!owned) {
    try {
      const lease = readPeopleMigrationLease(profilePath)
      if (lease)
        for (const pid of [lease.value.parentPid, lease.value.childPid]) {
          if (!pid) continue
          try {
            process.kill(pid, 0)
            owned = true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') owned = true
          }
        }
    } catch {
      owned = true
    }
  }
  return owned
}

export function assertPeopleDonorMutationAllowed(
  profilePath: string,
  previous: LegacyDonorChat | null,
  next: LegacyDonorChat
): void {
  const owned = peopleDonorMutationOwned(profilePath)
  if (owned && changesLegacyPeopleDonors(previous, next))
    throw new Error('Collaboration history is being migrated; this donor edit is waiting')
}
