/**
 * Minimal async concurrency limiter. Bounds how many heavy media subprocesses
 * (ffmpeg transcode / thumbnail — genuinely CPU-heavy, unlike metadata-only
 * ffprobe) run at once, so N agents can't spawn N encoders and saturate the box.
 * Pure + unit-testable.
 */

export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>
  readonly active: number
  readonly queued: number
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  const max = Math.max(1, Math.floor(Number.isFinite(maxConcurrent) ? maxConcurrent : 1))
  let active = 0
  const queue: Array<() => void> = []

  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < max) {
        active += 1
        resolve()
      } else {
        queue.push(resolve)
      }
    })

  const release = (): void => {
    const next = queue.shift()
    if (next) {
      next() // hand the slot directly to the next waiter — active stays the same
    } else {
      active -= 1
    }
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await task()
      } finally {
        release()
      }
    },
    get active() {
      return active
    },
    get queued() {
      return queue.length
    }
  }
}
