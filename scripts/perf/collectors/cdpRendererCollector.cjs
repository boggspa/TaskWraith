'use strict'

/**
 * CDP renderer collector (Profiler / HeapProfiler / Performance / Tracing).
 * Source-independent: dependency-injected CDP session adapter. Does NOT attach.
 */

/**
 * @typedef {object} CdpSessionAdapter
 * @property {(method: string, params?: object) => Promise<unknown>} send
 */

/**
 * @param {CdpSessionAdapter} session
 * @param {object} [options]
 * @param {string} [options.cpuProfilePath]
 * @param {string} [options.heapSnapshotPath]
 * @param {{ writeFileSync?: Function }} [options.fs]
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
      if (pathOut && options.fs && typeof options.fs.writeFileSync === 'function') {
        options.fs.writeFileSync(pathOut, JSON.stringify(profile), 'utf8')
      }
      await session.send('Profiler.disable').catch(() => {})
      return { profile, path: pathOut }
    }
  }
}

/**
 * @param {CdpSessionAdapter} session
 * @param {object} [options]
 * @param {string} [options.heapSnapshotPath]
 * @param {{ writeFileSync?: Function }} [options.fs]
 * @param {(chunk: string) => void} [options.onChunk]
 */
async function collectRendererHeapSnapshot(session, options = {}) {
  if (!session || typeof session.send !== 'function') {
    throw new Error('CDP session adapter with send() required')
  }
  await session.send('HeapProfiler.enable')
  const chunks = []
  const onChunk =
    options.onChunk ||
    ((chunk) => {
      chunks.push(chunk)
    })
  // Adapters may surface chunk events via session.on; unit tests inject onChunk.
  const result = await session.send('HeapProfiler.takeHeapSnapshot', {
    reportProgress: false
  })
  if (typeof result === 'string') onChunk(result)
  else if (result && typeof result.snapshot === 'string') onChunk(result.snapshot)
  const body = chunks.join('')
  const pathOut = options.heapSnapshotPath || null
  if (pathOut && options.fs && typeof options.fs.writeFileSync === 'function' && body) {
    options.fs.writeFileSync(pathOut, body, 'utf8')
  }
  await session.send('HeapProfiler.disable').catch(() => {})
  return { path: pathOut, bytes: Buffer.byteLength(body, 'utf8'), chunkCount: chunks.length }
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

module.exports = {
  collectRendererCpuProfile,
  collectRendererHeapSnapshot,
  collectRendererPerformanceMetrics,
  startRendererTracing
}
