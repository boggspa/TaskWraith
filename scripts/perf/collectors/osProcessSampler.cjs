'use strict'

/**
 * OS process CPU / RSS / GPU / zombie sampler.
 * All syscalls go through injected adapters — unit tests never touch live processes.
 */

/**
 * @typedef {object} OsSamplerAdapters
 * @property {() => Array<{ pid: number, type?: string, cpu?: number, memory?: { workingSetSize?: number } }>} [getAppMetrics]
 * @property {() => string} [readLoadAvg]
 * @property {() => Array<{ pid: number, ppid: number, state: string, elapsedMs: number }>} [listZombies]
 * @property {() => number} [sampleGpuUtilPct]
 * @property {() => number} [nowMs]
 */

/**
 * @param {OsSamplerAdapters} adapters
 */
function sampleProcessCpuRss(adapters = {}) {
  if (typeof adapters.getAppMetrics !== 'function') {
    throw new Error('getAppMetrics adapter required')
  }
  const metrics = adapters.getAppMetrics() || []
  let mainCpu = 0
  let rendererCpu = 0
  let mainRss = 0
  let rendererRss = 0
  let gpuCpu = 0
  for (const m of metrics) {
    const cpu = typeof m.cpu === 'number' ? m.cpu : 0
    const rss =
      m.memory && typeof m.memory.workingSetSize === 'number' ? m.memory.workingSetSize * 1024 : 0
    const type = (m.type || '').toLowerCase()
    if (type === 'browser' || type === 'main') {
      mainCpu += cpu
      mainRss += rss
    } else if (type === 'gpu') {
      gpuCpu += cpu
    } else {
      rendererCpu += cpu
      rendererRss += rss
    }
  }
  return {
    mainCpuPct: mainCpu,
    rendererCpuPct: rendererCpu,
    gpuProcessCpuPct: gpuCpu,
    mainRssBytes: mainRss,
    rendererRssBytes: rendererRss,
    processCount: metrics.length
  }
}

/**
 * @param {OsSamplerAdapters} adapters
 * @param {number} [zombieAgeMs=500]
 */
function sampleZombieChildren(adapters = {}, zombieAgeMs = 500) {
  if (typeof adapters.listZombies !== 'function') {
    throw new Error('listZombies adapter required')
  }
  const list = adapters.listZombies() || []
  const over = list.filter(
    (z) => z && z.state === 'Z' && typeof z.elapsedMs === 'number' && z.elapsedMs > zombieAgeMs
  )
  return {
    zombieCount: list.length,
    zombieOver500msCount: over.length,
    zombies: list
  }
}

/**
 * @param {OsSamplerAdapters} adapters
 */
function sampleGpuUtil(adapters = {}) {
  if (typeof adapters.sampleGpuUtilPct !== 'function') {
    throw new Error('sampleGpuUtilPct adapter required')
  }
  const util = adapters.sampleGpuUtilPct()
  if (typeof util !== 'number' || !Number.isFinite(util)) {
    throw new Error('sampleGpuUtilPct must return a finite number')
  }
  return { utilPct: util }
}

/**
 * @param {OsSamplerAdapters} adapters
 * @param {{ occluded?: boolean }} [opts]
 */
function sampleOsBundle(adapters = {}, opts = {}) {
  const cpuRss = sampleProcessCpuRss(adapters)
  const zombies = sampleZombieChildren(adapters)
  const gpu = sampleGpuUtil(adapters)
  return {
    sampledAtMs: typeof adapters.nowMs === 'function' ? adapters.nowMs() : Date.now(),
    occluded: Boolean(opts.occluded),
    ...cpuRss,
    ...zombies,
    gpuUtilPct: gpu.utilPct,
    occludedGpuUtilPct: opts.occluded ? gpu.utilPct : null
  }
}

module.exports = {
  sampleProcessCpuRss,
  sampleZombieChildren,
  sampleGpuUtil,
  sampleOsBundle
}
