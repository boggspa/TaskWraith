/**
 * The switch for barrier durability: every thread store writes without a sync
 * and notes what it owes, and only the moments the user or another component
 * is told "done" wait for a barrier that pays it off the event loop.
 *
 * Only the app acts on it. The stores it changes are the app's own files and
 * the Host takes no part, so there is nothing for the two to agree on; the
 * history decoder, which reads those files wherever it runs, reads the switch
 * through `ThreadBarrierDurabilityEnv` to read them as the app wrote them.
 * Only the exact token `1` is on; anything else, an absent variable included,
 * is off.
 *
 * Two rules decide what the process honours, each announced by one warning:
 * - It is never combined with the earlier mechanisms: while any of the
 *   durability flusher's switches is on, or checkpoint publication's, this one
 *   is ignored.
 * - Thread log authority builds on it: without barrier durability, the app
 *   ignores authority and never claims a thread. The Host reads the authority
 *   switch on its own and needs nothing from this one.
 *
 * Barrier durability folds checkpoints in a worker pool of its own, which the
 * journal is handed whole. While it is honoured, TASKWRAITH_CHECKPOINT_WORKER
 * no longer matters: the worker that switch asks for, and the host reference
 * connector it starts folds through, belong to the earlier mechanisms and are
 * not built.
 *
 * Resolve it once, when the store is built, and keep the answer for the life
 * of the process.
 */
import {
  isThreadLogAuthorityEnabled,
  THREAD_LOG_AUTHORITY_ENV
} from '../../host-shared/thread-log/ThreadLogAuthoritySwitch'
import { isCheckpointPreparationWorkerEnabled } from './CheckpointPreparationWorker'
import {
  barrierDurabilityExclusions,
  isThreadBarrierDurabilityRequested,
  THREAD_BARRIER_DURABILITY_ENV,
  type ThreadDurabilityEnvironment as Environment
} from './ThreadBarrierDurabilityEnv'

export {
  CHECKPOINT_PUBLICATION_ENV,
  FLUSHER_DURABILITY_ENVS,
  isThreadBarrierDurabilityRequested,
  THREAD_BARRIER_DURABILITY_ENV
} from './ThreadBarrierDurabilityEnv'

export interface ThreadDurabilitySwitches {
  /** Barrier durability as this process honours it. */
  readonly barrierDurability: boolean
  /** Why barrier durability was asked for and is not honoured, else null. */
  readonly barrierDurabilityIgnored: string | null
  /** Thread log authority as this app process honours it. */
  readonly logAuthority: boolean
  /** Why authority was asked for and is not honoured, else null. */
  readonly logAuthorityIgnored: string | null
  /**
   * Whether the store builds the checkpoint worker of the earlier mechanisms,
   * as TASKWRAITH_CHECKPOINT_WORKER asks. Never while barrier durability is
   * honoured, which builds a pool of its own.
   */
  readonly checkpointWorker: boolean
}

export function resolveThreadDurabilitySwitches(
  env: Environment = process.env,
  warn: (message: string) => void = console.warn
): ThreadDurabilitySwitches {
  const requested = isThreadBarrierDurabilityRequested(env)
  const excluding = barrierDurabilityExclusions(env)
  let barrierDurabilityIgnored: string | null = null
  if (requested && excluding.length > 0) {
    barrierDurabilityIgnored = `${excluding.join(', ')} on`
    warn(
      `${THREAD_BARRIER_DURABILITY_ENV} is ignored: ${excluding.join(', ')} ${excluding.length === 1 ? 'is' : 'are'} on, and the two durability mechanisms are never combined.`
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
    logAuthorityIgnored,
    checkpointWorker: !barrierDurability && isCheckpointPreparationWorkerEnabled(env)
  }
}
