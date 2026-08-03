'use strict'

/**
 * Node-inspector main-process CPU / heap collector.
 * Dependency-injected inspector / v8 adapters. Does NOT launch Electron.
 */

/**
 * @typedef {object} InspectorSessionAdapter
 * @property {(method: string, params?: object) => Promise<unknown> | unknown} post
 * @property {(event: string, handler: Function) => void} [on]
 * @property {() => void} [connect]
 * @property {() => void} [disconnect]
 */

/**
 * @param {InspectorSessionAdapter} session
 * @param {object} [options]
 * @param {string} [options.cpuProfilePath]
 * @param {{ writeFileSync?: Function }} [options.fs]
 * @param {number} [options.samplingInterval]
 */
async function collectMainCpuProfile(session, options = {}) {
  if (!session || typeof session.post !== 'function') {
    throw new Error('inspector session adapter with post() required')
  }
  if (typeof session.connect === 'function') session.connect()
  await Promise.resolve(session.post('Profiler.enable'))
  await Promise.resolve(
    session.post('Profiler.setSamplingInterval', {
      interval: options.samplingInterval || 1000
    })
  )
  await Promise.resolve(session.post('Profiler.start'))
  return {
    kind: 'main_cpu_profile_started',
    stop: async () => {
      const result = /** @type {{ profile?: object }} */ (
        await Promise.resolve(session.post('Profiler.stop'))
      )
      const profile = result && result.profile ? result.profile : result
      const pathOut = options.cpuProfilePath || null
      if (pathOut && options.fs && typeof options.fs.writeFileSync === 'function') {
        options.fs.writeFileSync(pathOut, JSON.stringify(profile), 'utf8')
      }
      await Promise.resolve(session.post('Profiler.disable')).catch(() => {})
      if (typeof session.disconnect === 'function') session.disconnect()
      return { profile, path: pathOut }
    }
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.heapSnapshotPath]
 * @param {{ writeHeapSnapshot?: Function }} [options.v8]
 * @param {{ writeFileSync?: Function, readFileSync?: Function }} [options.fs]
 */
function collectMainHeapSnapshot(options = {}) {
  const v8 = options.v8
  if (!v8 || typeof v8.writeHeapSnapshot !== 'function') {
    throw new Error('v8.writeHeapSnapshot adapter required')
  }
  const pathOut = options.heapSnapshotPath || v8.writeHeapSnapshot()
  if (options.heapSnapshotPath && pathOut !== options.heapSnapshotPath) {
    // Some adapters ignore the path arg and return their own; caller records whatever landed.
  }
  let bytes = 0
  if (options.fs && typeof options.fs.readFileSync === 'function' && pathOut) {
    try {
      bytes = options.fs.readFileSync(pathOut).length
    } catch {
      bytes = 0
    }
  }
  return { path: pathOut, bytes }
}

/**
 * Sample main-process memory via injected process.memoryUsage.
 * @param {{ memoryUsage?: () => NodeJS.MemoryUsage }} [proc]
 */
function sampleMainMemory(proc = process) {
  if (!proc || typeof proc.memoryUsage !== 'function') {
    throw new Error('process.memoryUsage adapter required')
  }
  const mu = proc.memoryUsage()
  return {
    rss: mu.rss,
    heapTotal: mu.heapTotal,
    heapUsed: mu.heapUsed,
    external: mu.external || 0,
    arrayBuffers: mu.arrayBuffers || 0
  }
}

module.exports = {
  collectMainCpuProfile,
  collectMainHeapSnapshot,
  sampleMainMemory
}
