'use strict'

/**
 * CDP renderer collector (Profiler / HeapProfiler / Performance / Tracing).
 * Source-independent: dependency-injected CDP session adapter. Does NOT attach.
 *
 * Heap snapshots stream HeapProfiler.addHeapSnapshotChunk events directly to an
 * artifact temp file (never accumulate multi-GB snapshots in RAM).
 */

const crypto = require('crypto')
const path = require('path')

const DEFAULT_HEAP_MIN_BYTES = 64
const DEFAULT_CPU_PROFILE_MIN_BYTES = 32

/**
 * @typedef {object} CdpSessionAdapter
 * @property {(method: string, params?: object) => Promise<unknown>} send
 * @property {(handler: Function) => Function} [onEvent]
 */

/**
 * @param {object} fsApi
 * @param {string} filePath
 * @param {string|Buffer} data
 */
function writeFileSyncChecked(fsApi, filePath, data) {
  if (!fsApi || typeof fsApi.writeFileSync !== 'function') {
    throw new Error('fs.writeFileSync required to persist profile/heap artifacts')
  }
  fsApi.writeFileSync(filePath, data)
}

/**
 * @param {object} fsApi
 * @param {string} filePath
 */
function fsyncFile(fsApi, filePath) {
  if (typeof fsApi.openSync === 'function' && typeof fsApi.fsyncSync === 'function') {
    const fd = fsApi.openSync(filePath, 'r')
    try {
      fsApi.fsyncSync(fd)
    } finally {
      if (typeof fsApi.closeSync === 'function') fsApi.closeSync(fd)
    }
    return
  }
  if (typeof fsApi.fsyncSync === 'function' && typeof fsApi.openSync !== 'function') {
    // DI stub that fsyncs by path
    fsApi.fsyncSync(filePath)
  }
}

/**
 * Promote temp → final after fsync; delete only the exact incomplete temp on failure.
 * @param {object} fsApi
 * @param {string} tempPath
 * @param {string} finalPath
 */
function atomicPromote(fsApi, tempPath, finalPath) {
  fsyncFile(fsApi, tempPath)
  if (typeof fsApi.renameSync === 'function') {
    fsApi.renameSync(tempPath, finalPath)
  } else if (typeof fsApi.copyFileSync === 'function' && typeof fsApi.unlinkSync === 'function') {
    fsApi.copyFileSync(tempPath, finalPath)
    fsApi.unlinkSync(tempPath)
  } else {
    throw new Error('fs.renameSync (or copyFileSync+unlinkSync) required for atomic heap promote')
  }
  // Best-effort directory fsync when available
  if (typeof fsApi.openSync === 'function' && typeof fsApi.fsyncSync === 'function') {
    try {
      const dirFd = fsApi.openSync(path.dirname(finalPath), 'r')
      try {
        fsApi.fsyncSync(dirFd)
      } finally {
        if (typeof fsApi.closeSync === 'function') fsApi.closeSync(dirFd)
      }
    } catch {
      // ignore dir fsync failures on platforms that disallow directory open
    }
  }
}

/**
 * @param {CdpSessionAdapter} session
 * @param {object} [options]
 * @param {string} [options.cpuProfilePath]
 * @param {string} [options.heapSnapshotPath]
 * @param {number} [options.minBytes]
 * @param {{ writeFileSync?: Function, openSync?: Function, fsyncSync?: Function, closeSync?: Function, renameSync?: Function, unlinkSync?: Function, createWriteStream?: Function }} [options.fs]
 */
async function collectRendererCpuProfile(session, options = {}) {
  if (!session || typeof session.send !== 'function') {
    throw new Error('CDP session adapter with send() required')
  }
  await session.send('Profiler.enable')
  await session.send('Profiler.start')
  // Caller controls sampling window; stop is explicit.
  return {
    kind: 'renderer_cpu_profile_started',
    stop: async () => {
      const result = /** @type {{ profile?: object }} */ (await session.send('Profiler.stop'))
      const profile = result && result.profile ? result.profile : result
      const pathOut = options.cpuProfilePath || null
      const body = JSON.stringify(profile)
      const bytes = Buffer.byteLength(body, 'utf8')
      const minBytes = options.minBytes == null ? DEFAULT_CPU_PROFILE_MIN_BYTES : options.minBytes
      const sha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
      if (pathOut) {
        if (bytes < minBytes) {
          throw new Error(`CPU profile too small: ${bytes} < ${minBytes}`)
        }
        writeFileSyncChecked(options.fs, pathOut, body)
        if (options.fs) fsyncFile(options.fs, pathOut)
      }
      await session.send('Profiler.disable').catch(() => {})
      return { profile, path: pathOut, bytes, sha256 }
    }
  }
}

/**
 * Stream heap snapshot chunks to a temp file, fsync, atomically promote.
 * Requires session.onEvent for HeapProfiler.addHeapSnapshotChunk (real CDP).
 *
 * @param {CdpSessionAdapter} session
 * @param {object} [options]
 * @param {string} [options.heapSnapshotPath]
 * @param {number} [options.minBytes]
 * @param {{ writeFileSync?: Function, appendFileSync?: Function, openSync?: Function, writeSync?: Function, closeSync?: Function, fsyncSync?: Function, renameSync?: Function, unlinkSync?: Function, createWriteStream?: Function }} [options.fs]
 * @param {(chunk: string) => void} [options.onChunk] — optional extra observer (must not retain all chunks)
 * @param {() => number} [options.nowMs]
 * @param {number} [options.pid]
 */
async function collectRendererHeapSnapshot(session, options = {}) {
  if (!session || typeof session.send !== 'function') {
    throw new Error('CDP session adapter with send() required')
  }
  if (typeof session.onEvent !== 'function') {
    throw new Error(
      'CDP session.onEvent required to stream HeapProfiler.addHeapSnapshotChunk (refuse RAM-only / empty snapshots)'
    )
  }

  const pathOut = options.heapSnapshotPath || null
  const minBytes = options.minBytes == null ? DEFAULT_HEAP_MIN_BYTES : options.minBytes
  const fsApi = options.fs || null
  const nowMs = options.nowMs || (() => Date.now())
  const pid = options.pid == null ? process.pid : options.pid

  await session.send('HeapProfiler.enable')

  const hash = crypto.createHash('sha256')
  let bytes = 0
  let chunkCount = 0
  /** @type {string|null} */
  let tempPath = null
  /** @type {{ write: Function, end?: Function, destroy?: Function }|null} */
  let stream = null
  /** @type {number|null} */
  let fd = null
  let failed = false

  const cleanupTemp = () => {
    if (!tempPath || !fsApi) return
    try {
      if (stream && typeof stream.destroy === 'function') stream.destroy()
    } catch {
      // ignore
    }
    stream = null
    if (fd != null && typeof fsApi.closeSync === 'function') {
      try {
        fsApi.closeSync(fd)
      } catch {
        // ignore
      }
      fd = null
    }
    if (typeof fsApi.unlinkSync === 'function') {
      try {
        fsApi.unlinkSync(tempPath)
      } catch {
        // ignore missing
      }
    }
  }

  const writeChunk = (chunk) => {
    if (typeof chunk !== 'string' || chunk.length === 0) return
    chunkCount += 1
    const buf = Buffer.from(chunk, 'utf8')
    bytes += buf.length
    hash.update(buf)
    if (typeof options.onChunk === 'function') options.onChunk(chunk)
    if (stream && typeof stream.write === 'function') {
      stream.write(buf)
      return
    }
    if (fd != null && typeof fsApi.writeSync === 'function') {
      fsApi.writeSync(fd, buf)
      return
    }
    if (fsApi && typeof fsApi.appendFileSync === 'function' && tempPath) {
      fsApi.appendFileSync(tempPath, buf)
    }
  }

  if (pathOut) {
    if (!fsApi) {
      throw new Error('options.fs required when heapSnapshotPath is set')
    }
    tempPath = `${pathOut}.tmp-${pid}-${nowMs()}`
    if (typeof fsApi.createWriteStream === 'function') {
      stream = fsApi.createWriteStream(tempPath)
    } else if (typeof fsApi.openSync === 'function') {
      fd = fsApi.openSync(tempPath, 'w')
    } else if (typeof fsApi.writeFileSync === 'function') {
      fsApi.writeFileSync(tempPath, '')
    } else {
      throw new Error('fs createWriteStream/openSync/writeFileSync required for heap streaming')
    }
  }

  const unsubscribe = session.onEvent((msg) => {
    if (!msg || msg.method !== 'HeapProfiler.addHeapSnapshotChunk') return
    const chunk = msg.params && typeof msg.params.chunk === 'string' ? msg.params.chunk : null
    if (chunk) writeChunk(chunk)
  })

  try {
    const result = await session.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false
    })
    // Compatibility: some DI fakes return the snapshot body from send() instead of events.
    if (typeof result === 'string') writeChunk(result)
    else if (result && typeof result.snapshot === 'string') writeChunk(result.snapshot)

    if (bytes < minBytes) {
      failed = true
      throw new Error(`heap snapshot too small / empty: ${bytes} < ${minBytes}`)
    }

    if (pathOut && tempPath && fsApi) {
      if (stream && typeof stream.end === 'function') {
        await new Promise((resolve, reject) => {
          stream.end((err) => (err ? reject(err) : resolve()))
        }).catch(() => {
          // sync DI streams may not take callbacks
        })
      }
      if (fd != null && typeof fsApi.closeSync === 'function') {
        fsApi.closeSync(fd)
        fd = null
      }
      stream = null
      atomicPromote(fsApi, tempPath, pathOut)
      tempPath = null
    }

    await session.send('HeapProfiler.disable').catch(() => {})
    return {
      path: pathOut,
      bytes,
      chunkCount,
      sha256: hash.digest('hex'),
      streamed: true
    }
  } catch (error) {
    failed = true
    cleanupTemp()
    await session.send('HeapProfiler.disable').catch(() => {})
    throw error
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe()
    if (failed && tempPath) cleanupTemp()
  }
}

/**
 * @param {CdpSessionAdapter} session
 */
async function collectRendererPerformanceMetrics(session) {
  if (!session || typeof session.send !== 'function') {
    throw new Error('CDP session adapter with send() required')
  }
  await session.send('Performance.enable')
  const metrics = /** @type {{ metrics?: Array<{ name: string, value: number }> }} */ (
    await session.send('Performance.getMetrics')
  )
  await session.send('Performance.disable').catch(() => {})
  /** @type {Record<string, number>} */
  const map = {}
  const list = metrics && Array.isArray(metrics.metrics) ? metrics.metrics : []
  for (const m of list) {
    if (m && typeof m.name === 'string' && typeof m.value === 'number') {
      map[m.name] = m.value
    }
  }
  return {
    jsHeapUsedSize: map.JSHeapUsedSize || 0,
    jsHeapTotalSize: map.JSHeapTotalSize || 0,
    nodes: map.Nodes || 0,
    layoutCount: map.LayoutCount || 0,
    raw: map
  }
}

/**
 * @param {CdpSessionAdapter} session
 * @param {object} [options]
 * @param {string[]} [options.categories]
 */
async function startRendererTracing(session, options = {}) {
  if (!session || typeof session.send !== 'function') {
    throw new Error('CDP session adapter with send() required')
  }
  const categories = options.categories || [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'v8.execute'
  ]
  await session.send('Tracing.start', {
    categories: categories.join(','),
    options: 'sampling-frequency=1000'
  })
  return {
    kind: 'renderer_tracing_started',
    stop: async () => {
      const result = await session.send('Tracing.end')
      return { tracingResult: result || null }
    }
  }
}

/**
 * Verify a profile/heap artifact exists, meets min size, and return sha256.
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.minBytes]
 * @param {{ readFileSync?: Function, existsSync?: Function, statSync?: Function }} [options.fs]
 */
function verifyArtifactFile(filePath, options = {}) {
  const fsApi = options.fs || require('fs')
  const minBytes = options.minBytes == null ? DEFAULT_HEAP_MIN_BYTES : options.minBytes
  if (typeof fsApi.existsSync === 'function' && !fsApi.existsSync(filePath)) {
    throw new Error(`artifact missing: ${filePath}`)
  }
  let bytes = 0
  let body
  if (typeof fsApi.statSync === 'function') {
    bytes = fsApi.statSync(filePath).size
  }
  if (typeof fsApi.readFileSync === 'function') {
    body = fsApi.readFileSync(filePath)
    bytes = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body))
  }
  if (bytes < minBytes) {
    throw new Error(`artifact too small: ${filePath} (${bytes} < ${minBytes})`)
  }
  const sha256 = crypto
    .createHash('sha256')
    .update(body == null ? Buffer.alloc(0) : body)
    .digest('hex')
  return { path: filePath, bytes, sha256 }
}

module.exports = {
  DEFAULT_HEAP_MIN_BYTES,
  DEFAULT_CPU_PROFILE_MIN_BYTES,
  collectRendererCpuProfile,
  collectRendererHeapSnapshot,
  collectRendererPerformanceMetrics,
  startRendererTracing,
  verifyArtifactFile
}
