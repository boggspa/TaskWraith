'use strict'

const path = require('node:path')
const { runT2BaselineCli } = require('./runT2Baseline.cjs')
const { runT2LiveLanes, liveLanesTeardownFailures } = require('./t2LiveLanes.cjs')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  // Both ready and complete can reject before the coordinator awaits them.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** Real T2 sessions: the runner owns isolation, exact-child cleanup and artifacts. */
function createMultiProfileLifecycle(options = {}, dependencies = {}) {
  const run = dependencies.run || runT2BaselineCli
  const lanes = dependencies.runLiveLanes || runT2LiveLanes
  const handles = new Map()
  const phaseReports = []
  const cancelled = deferred()
  const abort = () => {
    cancelled.reject(new Error('Capture cancelled'))
    for (const handle of handles.values()) {
      handle.controller.abort()
      handle.go.resolve()
    }
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  let incarnation = 0
  async function start(instance) {
    if (options.signal?.aborted) throw new Error('Capture cancelled')
    const ready = deferred()
    const go = deferred()
    const captured = deferred()
    const finish = deferred()
    const controller = new AbortController()
    const handle = {
      instance,
      ready,
      go,
      captured,
      finish,
      controller,
      measured: false,
      laneOperations: new Set(),
      laneOptions: null
    }
    const id = instance.launch.instanceId
    const artifactDir = path.join(options.artifactDir, `${id}-${++incarnation}`)
    const argv = [
      '--workload=light_beside_large_live',
      '--live-lanes',
      '--launch',
      '--i-accept-isolated-launch',
      '--materialize-instance-userdata',
      `--home=${instance.launch.home}`,
      `--instance-id=${id}`,
      `--port=${instance.launch.remoteDebuggingPort}`,
      `--inspect-port=${instance.launch.mainInspectorPort}`,
      `--artifact-dir=${artifactDir}`,
      `--out-dir=${artifactDir}`,
      `--cell=${options.cell}`,
      `--build-id=${options.buildId}`,
      `--seed=${options.seed || '1'}`,
      ...(options.flags || []).map((flag) => `--flag=${flag}`)
    ]
    handle.done = run(argv, {
      ...(options.runnerOptions || {}),
      repoRoot: instance.launch.repoRoot,
      signal: controller.signal,
      onVerifiedCaptureSession: async (session) => {
        handle.session = session
        ready.resolve(handle)
        await go.promise
        if (controller.signal.aborted) throw new Error('Capture stopped before measurement')
      },
      runLiveLanes: async (laneOptions) => {
        handle.laneOptions = laneOptions
        return lanes(laneOptions)
      },
      onCaptureSessionComplete: async ({ report }) => {
        handle.report = report
        captured.resolve(report)
        await finish.promise
      }
    }).catch((error) => {
      ready.reject(error)
      captured.reject(error)
      throw error
    })
    handle.done.catch(() => {})
    handles.set(instance.userDataPath, handle)
    try {
      return await Promise.race([ready.promise, cancelled.promise])
    } catch (error) {
      await handle.done.catch((failure) => {
        if (failure.cleanupFailures?.length) throw new Error('Owned capture cleanup failed')
      })
      handles.delete(instance.userDataPath)
      throw error
    }
  }
  async function stop(handle) {
    handle.controller.abort()
    handle.go.resolve()
    await Promise.allSettled([...handle.laneOperations])
    handle.finish.resolve()
    const result = await handle.done.catch((error) => {
      if (error.cleanupFailures?.length) throw new Error('Owned capture cleanup failed')
      if (!handle.controller.signal.aborted) throw new Error('Capture failed before cleanup')
      return null
    })
    handles.delete(handle.instance.userDataPath)
    if (result && result.report && result.report.cleanupFailures?.length) {
      throw new Error('Owned capture cleanup failed')
    }
  }
  async function measure({ phase, plan, handles: live }) {
    if (options.signal?.aborted) throw new Error('Capture cancelled')
    const active = [...live.entries()].filter(([index]) => plan.instances[index].role === 'active')
    const reports = await Promise.all(
      active.map(async ([, handle]) => {
        if (!handle.measured) {
          handle.measured = true
          handle.go.resolve()
          const report = await Promise.race([handle.captured.promise, cancelled.promise])
          if (!report.liveRounds?.verdict?.ok) throw new Error('Live capture inconclusive')
          return { instanceId: handle.instance.launch.instanceId, liveRounds: report.liveRounds }
        }
        if (!handle.laneOptions) throw new Error('Live window adapter unavailable')
        const signal = handle.controller.signal
        const sleep =
          handle.laneOptions.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
        const cancellableSleep = (ms) =>
          new Promise((resolve, reject) => {
            const abortWait = () => {
              signal.removeEventListener('abort', abortWait)
              reject(new Error('Capture cancelled'))
            }
            if (signal.aborted) return abortWait()
            signal.addEventListener('abort', abortWait, { once: true })
            Promise.resolve()
              .then(() => sleep(ms))
              .then(
                (value) => {
                  signal.removeEventListener('abort', abortWait)
                  resolve(value)
                },
                (error) => {
                  signal.removeEventListener('abort', abortWait)
                  reject(error)
                }
              )
          })
        const operation = Promise.resolve().then(() =>
          lanes({
            ...handle.laneOptions,
            signal,
            sleep: cancellableSleep,
            laneOptions: { ...handle.laneOptions.laneOptions, sleep: cancellableSleep }
          })
        )
        handle.laneOperations.add(operation)
        operation.finally(() => handle.laneOperations.delete(operation)).catch(() => {})
        const result = await Promise.race([operation, cancelled.promise])
        if (!result.verdict?.ok || liveLanesTeardownFailures(result).length) {
          throw new Error('Repeated live windows inconclusive')
        }
        return { instanceId: handle.instance.launch.instanceId, liveLanes: result }
      })
    )
    phaseReports.push({ phase, reports, evidenceEligibility: 'diagnostic-live-windows' })
  }
  return {
    start,
    stop,
    measure,
    phaseReports,
    cancel: async () => {
      abort()
      const results = await Promise.allSettled([...handles.values()].map(stop))
      options.signal?.removeEventListener('abort', abort)
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Owned capture cleanup failed')
      }
    },
    collectIdentity: async ({ userDataPath }) =>
      handles.get(userDataPath)?.session?.serverInstance || { ok: false, reason: 'session_missing' }
  }
}

module.exports = { createMultiProfileLifecycle }
