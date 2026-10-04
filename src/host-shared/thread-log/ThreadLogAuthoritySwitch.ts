/**
 * The switch for thread log authority: an app process and the Host agreeing,
 * thread by thread, on a single writer.
 *
 * Both processes read it here, so they cannot come to mean different things by
 * "on": only the exact token `1` is on, and anything else, an absent variable
 * included, is off. It stands alone; no durability switch has to be on with it.
 *
 * Read it once, when building the part that acts on it, and keep that answer
 * for the life of the process. Each side tells the other what it decided over
 * the connection, so a side that changed its mind part-way would leave the
 * other holding an agreement nobody honours.
 */
export const THREAD_LOG_AUTHORITY_ENV = 'TASKWRAITH_THREAD_LOG_AUTHORITY'

export function isThreadLogAuthorityEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env[THREAD_LOG_AUTHORITY_ENV] === '1'
}
