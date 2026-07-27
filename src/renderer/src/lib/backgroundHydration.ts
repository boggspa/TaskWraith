/** Resolve a non-critical IPC refresh within a small UI deadline.
 *
 * The underlying operation keeps running so its own cache can warm, but the
 * current render gets an honest fallback instead of holding an application
 * refresh lock forever.
 */
export function resolveWithinDeadline<T>(
  request: Promise<T>,
  fallback: T,
  deadlineMs: number
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }
    const timeout = setTimeout(() => finish(fallback), deadlineMs)
    request.then(finish).catch(() => finish(fallback))
  })
}
