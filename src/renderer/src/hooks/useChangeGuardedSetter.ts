import { useMemo, type Dispatch, type SetStateAction } from 'react'

const UNSET = Symbol('unset')

/**
 * Wrap a state setter so a value identical to the last one written never
 * schedules a render. React's own same-value bailout is only eager while the
 * component has no pending work; a busy composition root almost always has
 * some, so a setter called with the value already committed still queues a
 * full render that bails out only after the component function has run (App
 * re-set a cached summary object on every unrelated commit, 2026-09-05).
 *
 * Every write to the guarded state must go through the returned function; a
 * write around it leaves the guard's last-written value stale.
 */
export function createChangeGuardedSetter<T>(setter: (next: T) => void): (next: T) => void {
  let last: T | typeof UNSET = UNSET
  return (next: T) => {
    if (last !== UNSET && Object.is(last, next)) return
    last = next
    setter(next)
  }
}

export function useChangeGuardedSetter<T>(setter: Dispatch<SetStateAction<T>>): (next: T) => void {
  return useMemo(() => createChangeGuardedSetter<T>(setter), [setter])
}
