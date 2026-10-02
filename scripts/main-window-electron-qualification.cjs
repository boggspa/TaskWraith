const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { isolatedEnvironment, execute } = require('./main-durability-electron-qualification.cjs')

function mainSource() {
  return `
const { app, powerSaveBlocker } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createMainPerfInstrumentation } = require('./instrumentation.cjs')
const { productionMainPerfClock } = require('./clock.cjs')
const { createMainWindowPerfProbes } = require('./probes.cjs')
const { qualifyNativeMainProfile } = require('./calibration.cjs')
const state = process.env.TW_DURABILITY_QUALIFICATION_STATE
app.setPath('userData', path.join(state, 'user-data'))
app.setPath('logs', path.join(state, 'logs'))
app.disableHardwareAcceleration()
const ids = [], releases = []
function acquire() {
  const id = powerSaveBlocker.start('prevent-app-suspension'); ids.push(id)
  assert(powerSaveBlocker.isStarted(id))
  return { held: () => powerSaveBlocker.isStarted(id), release: () => { powerSaveBlocker.stop(id); releases.push(id) } }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function run() {
  assert.equal(process.type, 'browser'); assert(__dirname.includes('.asar/'))
  await app.whenReady()
  const instrumentation = createMainPerfInstrumentation({ acquireWindowProtection: acquire })
  instrumentation.start()
  let completed
  try {
    const begin = instrumentation.snapshot({ window: { action: 'begin', id: 'platform_window', durationMs: 120 } }).window
    assert.equal(begin.status, 'started')
    await wait(20)
    const until = productionMainPerfClock.nowMs() + 35
    while (productionMainPerfClock.nowMs() < until) {}
    await wait(140)
    completed = instrumentation.snapshot({ window: { action: 'end', id: 'platform_window' } }).window
    assert.equal(completed.status, 'complete')
    assert.deepEqual(completed.clock, begin.clock)
    assert.equal(completed.clock.clockId, 'node.performance.now')
    assert(completed.clock.identity.includes('main:' + process.pid + ':'))
    assert.deepEqual(completed.loopGaps.clock, completed.clock)
    assert.equal(completed.loopGaps.suspensionProtection.heldThroughout, true)
    assert.equal(completed.loopGaps.censored, false)
    assert(completed.loopGaps.blockedMs >= 25)
    for (const value of Object.values(completed.eventLoopLag).filter(v => typeof v === 'number')) assert(Number.isFinite(value))
    assert(completed.eventLoopLag.sampling)
    assert(ids.every(id => !powerSaveBlocker.isStarted(id)))
    instrumentation.snapshot({ window: { action: 'begin', id: 'cancel_window', durationMs: 500 } })
  } finally { instrumentation.stop() }
  assert(ids.every(id => !powerSaveBlocker.isStarted(id)))
  const failing = createMainWindowPerfProbes({ acquireProtection: acquire, setTimer: () => { throw new Error('injected timer refusal') } })
  assert.equal(failing.request({ action: 'begin', id: 'error_window', durationMs: 100 }).status, 'unavailable')
  failing.stop()
  assert(ids.every(id => !powerSaveBlocker.isStarted(id)))
  const calibration = await qualifyNativeMainProfile({ outputRoot: state })
  assert(calibration.calibration.qualified, JSON.stringify(calibration.calibration.reasons))
  assert(calibration.calibration.anchors.every(a => a.pid === process.pid && a.identity === completed.clock.identity))
  assert.equal(ids.length, releases.length)
  fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify({ status: 'PASS', pid: process.pid, electron: process.versions.electron, completed, calibration, blockerIds: ids, released: releases, benchmarkPass: false, privateResidualsAligned: false, x3Qualified: false }, null, 2))
}
run().then(() => app.exit(0)).catch(error => {
  for (const id of ids) if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)
  fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify({ status: 'FAIL', error: error.stack }))
  app.exit(1)
})
`
}

async function prepare(root, repo = path.resolve(__dirname, '..')) {
  const env = isolatedEnvironment(root)
  const snapshot = path.join(root, 'source-snapshot')
  const packageDir = path.join(root, 'package'),
    out = path.join(packageDir, 'out')
  for (const directory of [
    snapshot,
    out,
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.TW_DURABILITY_QUALIFICATION_STATE,
    path.join(env.TW_DURABILITY_QUALIFICATION_STATE, 'user-data'),
    path.join(env.TW_DURABILITY_QUALIFICATION_STATE, 'logs')
  ])
    fs.mkdirSync(directory, { recursive: true })
  const files = [
    'src/main/perf/MainPerfSnapshot.ts',
    'src/main/perf/MainPerfClock.ts',
    'src/main/perf/MainWindowPerfProbes.ts',
    'src/main/perf/MainLoopGapRecorder.ts',
    'src/main/perf/EventLoopLagMeter.ts',
    'src/main/perf/HostLoadSample.ts',
    'src/host-shared/perf/EventLoopLagMeter.ts',
    'scripts/perf/collectors/nativeMainProfileCalibration.cjs',
    'scripts/perf/collectors/mainProfileCalibration.cjs',
    'scripts/perf/boundedAwait.cjs'
  ]
  const sourceSha256 = {}
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(repo, file)),
      target = path.join(snapshot, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes, { mode: 0o400 })
    sourceSha256[file] = createHash('sha256').update(bytes).digest('hex')
  }
  await require('esbuild').build({
    entryPoints: {
      instrumentation: path.join(snapshot, files[0]),
      clock: path.join(snapshot, files[1]),
      probes: path.join(snapshot, files[2]),
      calibration: path.join(snapshot, files[7])
    },
    outdir: out,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22'
  })
  fs.writeFileSync(path.join(out, 'main.cjs'), mainSource())
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'main-window-qualification', version: '1.0.0', main: 'out/main.cjs' })
  )
  const archive = path.join(root, 'qualification.asar')
  await require('@electron/asar').createPackage(packageDir, archive)
  return {
    root,
    archive,
    env,
    sourceSha256,
    archiveSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  }
}
module.exports = { mainSource, prepare, execute }
