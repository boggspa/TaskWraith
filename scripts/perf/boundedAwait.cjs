'use strict'

/**
 * Bound an in-flight thenable. The inner work is not cancelled — callers must
 * still tear down the underlying session — but the await settles.
 *
 * @param {Promise<unknown>|*} work
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<unknown>}
 */
function awaitWithTimeout(work, timeoutMs, label) {
  const name = typeof label === 'string' && label.trim() ? label.trim() : 'operation'
  const ms = Number(timeoutMs)
  if (!Number.isFinite(ms) || ms <= 0) {
    const err = new Error(`${name} timed out after 0ms`)
    err.code = 'CAPTURE_TIMEOUT'
    return Promise.reject(err)
  }
  const promise = Promise.resolve(work)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${name} timed out after ${Math.floor(ms)}ms`)
      err.code = 'CAPTURE_TIMEOUT'
      reject(err)
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

module.exports = { awaitWithTimeout }
