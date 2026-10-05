/**
 * The wait before a reply tells a person that a change they made to the run
 * queue is done: a prompt queued, a queued run cancelled, a queued message
 * edited or removed, a queued message steered.
 *
 * Under barrier durability the queue's file follows its list in memory a
 * write behind, so the reply waits, bounded, for a finished write that holds
 * the change, as a message's reply waits for its barrier. The store installs
 * the wait while the switch is on. With none installed nothing waits and a
 * reply that was synchronous stays synchronous. Automatic transitions, a run
 * starting, running, finishing, failing or being recovered, never come here.
 */

/** Null when nothing is waiting to be written. */
type RunQueueUserWait = () => Promise<void> | null

let installed: RunQueueUserWait | null = null

/** The store installs its wait while barrier durability is on, and removes it with null. */
export function installRunQueueUserWait(wait: RunQueueUserWait | null): void {
  installed = wait
}

/** A reply to a person's change to the run queue, once a finished write holds the change. */
export function afterRunQueueUserChange<T>(reply: T): T | Promise<T> {
  const waiting = installed?.() ?? null
  return waiting ? waiting.then(() => reply) : reply
}
