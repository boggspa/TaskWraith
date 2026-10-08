/**
 * Barrier durability's switch as the environment holds it, apart from all the
 * store builds with it: a process that only reads the app's files, the
 * history decoder in the app's catalogue process or in the Host's, tells
 * from it how the app wrote them, without loading the store's modules. The
 * rules are the ones `resolveThreadDurabilitySwitches` announces: it is on by
 * default and only the exact token `0` turns it off, and the switch is ignored
 * while any of the earlier mechanisms' switches is on.
 */

export const THREAD_BARRIER_DURABILITY_ENV = 'TASKWRAITH_THREAD_BARRIER_DURABILITY'

/** The earlier flusher's switches, each on only for its own token `1`. */
export const FLUSHER_DURABILITY_ENVS = [
  'TASKWRAITH_JOURNAL_FLUSHER',
  'TASKWRAITH_RUN_EVENT_FLUSHER',
  'TASKWRAITH_CATALOGUE_DEFERRED_DURABILITY'
] as const

/** Checkpoint publication's switch, on only for its own token `1`. */
export const CHECKPOINT_PUBLICATION_ENV = 'TASKWRAITH_CHECKPOINT_PUBLICATION'

/** While any of these is on, barrier durability is ignored. */
const EXCLUDING_ENVS = [...FLUSHER_DURABILITY_ENVS, CHECKPOINT_PUBLICATION_ENV]

export type ThreadDurabilityEnvironment = Readonly<Record<string, string | undefined>>

/** Whether the environment asks for barrier durability, before the rules above. */
export function isThreadBarrierDurabilityRequested(
  env: ThreadDurabilityEnvironment = process.env
): boolean {
  return env[THREAD_BARRIER_DURABILITY_ENV] !== '0'
}

/** The switches that are on and make barrier durability ignored, in a fixed order. */
export function barrierDurabilityExclusions(
  env: ThreadDurabilityEnvironment = process.env
): string[] {
  return EXCLUDING_ENVS.filter((name) => env[name] === '1')
}

/** Whether barrier durability is honoured: asked for, and not ignored. */
export function isThreadBarrierDurabilityHonoured(
  env: ThreadDurabilityEnvironment = process.env
): boolean {
  return isThreadBarrierDurabilityRequested(env) && barrierDurabilityExclusions(env).length === 0
}
