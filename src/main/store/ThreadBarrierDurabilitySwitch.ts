/**
 * The switch for barrier durability: every thread store writes without a sync
 * and notes what it owes, and only the moments the user or another component
 * is told "done" wait for a barrier that pays it off the event loop.
 *
 * Only the app reads it. The stores it changes are the app's own files and the
 * Host takes no part, so there is nothing for the two to agree on. Only the
 * exact token `1` is on; anything else, an absent variable included, is off.
 *
 * Two rules decide what the process honours, each announced by one warning:
 * - It is never combined with the earlier durability flusher: while any of the
 *   flusher's switches is on, this one is ignored.
 * - Thread log authority builds on it: without barrier durability, the app
 *   ignores authority and never claims a thread. The Host reads the authority
 *   switch on its own and needs nothing from this one.
 *
 * Resolve it once, when the store is built, and keep the answer for the life
 * of the process.
 */
import {
  isThreadLogAuthorityEnabled,
  THREAD_LOG_AUTHORITY_ENV
} from '../../host-shared/thread-log/ThreadLogAuthoritySwitch'

export const THREAD_BARRIER_DURABILITY_ENV = 'TASKWRAITH_THREAD_BARRIER_DURABILITY'

/** The earlier flusher's switches, each on only for its own token `1`. */
export const FLUSHER_DURABILITY_ENVS = [
  'TASKWRAITH_JOURNAL_FLUSHER',
  'TASKWRAITH_RUN_EVENT_FLUSHER',
  'TASKWRAITH_CATALOGUE_DEFERRED_DURABILITY'
] as const

type Environment = Readonly<Record<string, string | undefined>>

export interface ThreadDurabilitySwitches {
  /** Barrier durability as this process honours it. */
  readonly barrierDurability: boolean
  /** Why barrier durability was asked for and is not honoured, else null. */
  readonly barrierDurabilityIgnored: string | null
  /** Thread log authority as this app process honours it. */
  readonly logAuthority: boolean
  /** Why authority was asked for and is not honoured, else null. */
  readonly logAuthorityIgnored: string | null
}

/** Whether the environment asks for barrier durability, before the rules above. */
export function isThreadBarrierDurabilityRequested(env: Environment = process.env): boolean {
  return env[THREAD_BARRIER_DURABILITY_ENV] === '1'
}

export function resolveThreadDurabilitySwitches(
  env: Environment = process.env,
  warn: (message: string) => void = console.warn
): ThreadDurabilitySwitches {
  const requested = isThreadBarrierDurabilityRequested(env)
  const flushers = FLUSHER_DURABILITY_ENVS.filter((name) => env[name] === '1')
  let barrierDurabilityIgnored: string | null = null
  if (requested && flushers.length > 0) {
    barrierDurabilityIgnored = `${flushers.join(', ')} on`
    warn(
      `${THREAD_BARRIER_DURABILITY_ENV} is ignored: ${flushers.join(', ')} ${flushers.length === 1 ? 'is' : 'are'} on, and the two durability mechanisms are never combined.`
    )
  }
  const barrierDurability = requested && barrierDurabilityIgnored === null
  let logAuthorityIgnored: string | null = null
  if (isThreadLogAuthorityEnabled(env) && !barrierDurability) {
    logAuthorityIgnored = `${THREAD_BARRIER_DURABILITY_ENV} ${requested ? 'ignored' : 'off'}`
    warn(
      `${THREAD_LOG_AUTHORITY_ENV} is ignored: it needs ${THREAD_BARRIER_DURABILITY_ENV}, which is ${requested ? 'ignored' : 'off'}.`
    )
  }
  return {
    barrierDurability,
    barrierDurabilityIgnored,
    logAuthority: isThreadLogAuthorityEnabled(env) && logAuthorityIgnored === null,
    logAuthorityIgnored
  }
}
