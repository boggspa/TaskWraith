const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const { createHash } = require('node:crypto')

function mainSource() {
  return `
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { MainDurabilityFsyncAdapter } = require('./adapter.cjs')
const { MainDurabilityFlusher } = require('./flusher.cjs')
const state = process.env.TW_DURABILITY_QUALIFICATION_STATE
assert(state && path.isAbsolute(state))
app.setPath('userData', path.join(state, 'user-data'))
app.setPath('logs', path.join(state, 'logs'))
app.disableHardwareAcceleration()
const adapters = []
const fds = []
const evidence = []
function open(name) {
  const fd = fs.openSync(path.join(state, name), 'a+')
  fds.push(fd)
  fs.writeSync(fd, 'page-cache bytes\\n')
  return fd
}
function adapter(entry, timeout) {
  const result = new MainDurabilityFsyncAdapter({ entryPath: entry, joinTimeoutMs: timeout })
  adapters.push(result)
  return result
}
async function main() {
  assert.equal(process.type, 'browser')
  assert.equal(process.versions.electron.split('.')[0], '41')
  assert(__dirname.includes('.asar/'), 'main must execute in ASAR')
  // Do not create a BrowserWindow or wait for GUI startup. Worker threads only.
  const workerEntry = path.join(__dirname, 'worker.cjs')
  const ports = adapter(workerEntry, 5000)
  const fd = open('ledger')
  let calls = 0
  let callbackError
  const ticket = ports.fsync(fd, error => { callbackError = error; calls++ })
  assert.equal(calls, 0)
  ticket.joinSync()
  assert.equal(calls, 1)
  assert.equal(callbackError, undefined)
  ticket.joinSync()
  assert.equal(calls, 1)
  evidence.push('ASAR shared-fd fsync joined without main callback delivery')
  const flusher = new MainDurabilityFlusher(ports)
  const otherFd = open('strict')
  const aStat = fs.fstatSync(fd), bStat = fs.fstatSync(otherFd)
  const a = flusher.open(aStat.dev, aStat.ino, fd)
  const b = flusher.open(bStat.dev, bStat.ino, otherFd)
  flusher.noteWrite(a, 17, 'prompt')
  flusher.noteWrite(b, 17, 'sync', { after: [{ file: a, offset: 17 }] })
  assert.equal(flusher.snapshot().dirtyFiles, 0)
  assert.equal(flusher.counters.asyncFsyncs, 1)
  assert.equal(flusher.counters.strictFsyncs, 1)
  evidence.push('strict boundary joins outstanding prompt dependency')
  if (process.platform !== 'win32') {
    const directoryFd = fs.openSync(state, 'r')
    fds.push(directoryFd)
    const directoryStat = fs.fstatSync(directoryFd)
    const directory = flusher.open(directoryStat.dev, directoryStat.ino, directoryFd)
    await new Promise((resolve,reject) => ports.fsync(directoryFd,error => error ? reject(error) : resolve()))
    evidence.push('real directory fd asynchronous worker fsync')
    const createdFd = open('created-with-directory-dependency')
    const createdStat = fs.fstatSync(createdFd)
    const created = flusher.open(createdStat.dev, createdStat.ino, createdFd)
    flusher.noteWrite(directory, 1, 'soft')
    flusher.noteWrite(created, 17, 'sync', {after:[{file:directory,offset:1}]})
    assert.equal(flusher.counters.dependencySyncFsyncs, 1)
    evidence.push('real directory fd fsync before strict lazy-create acknowledgement')
  } else evidence.push('directory fsync unavailable on Windows; existing platform policy retained')
  await new Promise((resolve, reject) => ports.fsync(fd, error => error ? reject(error) : resolve()))
  evidence.push('normal asynchronous shared completion')
  await ports.dispose()
  assert(fs.fstatSync(fd).isFile())
  evidence.push('worker disposal preserves main-owned descriptor')
  const stalled = adapter(path.join(__dirname, 'stalled.cjs'), 100)
  const stalledFd = open('stalled')
  let failure
  const stalledTicket = stalled.fsync(stalledFd, error => { failure = error })
  const before = performance.now()
  assert.throws(() => stalledTicket.joinSync(), /timed out/)
  assert(performance.now() - before < 1500)
  assert.equal(failure, undefined)
  assert.throws(() => stalled.close(stalledFd), /pinned/)
  assert.throws(() => stalled.fsyncSync(stalledFd), /timed out/)
  await stalled.dispose()
  assert(failure instanceof Error)
  assert(fs.fstatSync(stalledFd).isFile())
  evidence.push('bounded refusal retains pin until confirmed worker exit')
  for (const entry of ['startup-failure.cjs', 'worker-death.cjs']) {
    const failed = adapter(path.join(__dirname, entry), 1000)
    const ownedFd = open(entry + '.ledger')
    let failures = 0
    await new Promise(resolve => failed.fsync(ownedFd, error => {
      assert(error instanceof Error)
      failures++
      resolve()
    }))
    assert.equal(failures, 1)
    assert(fs.fstatSync(ownedFd).isFile())
    await failed.dispose()
    assert(fs.fstatSync(ownedFd).isFile())
    evidence.push(entry + ' settles once and preserves fd ownership')
  }
  const shutdownPorts = adapter(workerEntry, 5000)
  const shutdownFd = open('shutdown')
  const shutdownFlusher = new MainDurabilityFlusher(shutdownPorts)
  const shutdownStat = fs.fstatSync(shutdownFd)
  const shutdownFile = shutdownFlusher.open(shutdownStat.dev, shutdownStat.ino, shutdownFd)
  shutdownFlusher.noteWrite(shutdownFile, 17, 'prompt')
  shutdownFlusher.drainSync()
  await shutdownPorts.dispose()
  assert.equal(shutdownFlusher.snapshot().dirtyFiles, 0)
  assert(fs.fstatSync(shutdownFd).isFile())
  evidence.push('shutdown drains outstanding fsync before worker disposal')
  return { status: 'PASS', electron: process.versions.electron, node: process.versions.node,
    processType: process.type, asar: __dirname.includes('.asar/'), evidence, counters: flusher.counters }
}
main().then(async result => {
  for (const port of adapters) await port.dispose()
  for (const fd of fds) fs.closeSync(fd)
  fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(result, null, 2))
  app.exit(0)
}).catch(async error => {
  for (const port of adapters) { try { await port.dispose() } catch {} }
  for (const fd of fds) { try { fs.closeSync(fd) } catch {} }
  fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify({status:'FAIL', error:String(error), evidence}))
  app.exit(1)
})
`
}

function isolatedEnvironment(root) {
  // Deliberately do not inherit credentials, provider configuration or profile paths.
  const env = Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TMPDIR']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  )
  env.HOME = path.join(root, 'home')
  env.USERPROFILE = env.HOME
  env.XDG_CONFIG_HOME = path.join(root, 'config')
  env.XDG_CACHE_HOME = path.join(root, 'cache')
  env.TW_DURABILITY_QUALIFICATION_STATE = path.join(root, 'state')
  return env
}

async function prepare(root, repo = path.resolve(__dirname, '..')) {
  const { build } = require('esbuild')
  const asar = require('@electron/asar')
  const packageDir = path.join(root, 'package')
  const out = path.join(packageDir, 'out')
  const env = isolatedEnvironment(root)
  for (const directory of [
    out,
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.TW_DURABILITY_QUALIFICATION_STATE,
    path.join(env.TW_DURABILITY_QUALIFICATION_STATE, 'user-data'),
    path.join(env.TW_DURABILITY_QUALIFICATION_STATE, 'logs')
  ])
    fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'durability-qualification', version: '1.0.0', main: 'out/main.cjs' })
  )
  fs.writeFileSync(path.join(out, 'main.cjs'), mainSource())
  fs.writeFileSync(path.join(out, 'stalled.cjs'), 'setInterval(() => {}, 1000)\n')
  fs.writeFileSync(
    path.join(out, 'startup-failure.cjs'),
    'throw new Error("unexpected startup failure")\n'
  )
  fs.writeFileSync(
    path.join(out, 'worker-death.cjs'),
    'require("node:worker_threads").parentPort.on("message",()=>process.exit(9))\n'
  )
  const sourcePaths = {
    adapter: 'src/main/store/MainDurabilityFsyncAdapter.ts',
    worker: 'src/main/store/MainDurabilityFsyncWorker.ts',
    flusher: 'src/main/store/MainDurabilityFlusher.ts'
  }
  // Read once, then bundle and hash those exact immutable bytes.
  const snapshot = path.join(root, 'source-snapshot')
  fs.mkdirSync(snapshot)
  const sourceSha256 = {}
  for (const file of Object.values(sourcePaths)) {
    const bytes = fs.readFileSync(path.join(repo, file))
    sourceSha256[file] = createHash('sha256').update(bytes).digest('hex')
    fs.writeFileSync(path.join(snapshot, path.basename(file)), bytes, { mode: 0o400 })
  }
  await build({
    entryPoints: Object.fromEntries(
      Object.entries(sourcePaths).map(([name, file]) => [
        name,
        path.join(snapshot, path.basename(file))
      ])
    ),
    outdir: out,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22'
  })
  const archive = path.join(root, 'qualification.asar')
  await asar.createPackage(packageDir, archive)
  return {
    root,
    archive,
    env,
    sourceSha256,
    archiveSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  }
}

async function execute(prepared, options = {}) {
  const root = prepared.root
  let outcome
  let child
  let log
  try {
    outcome = await new Promise((resolve) => {
      let settled = false
      let confirmation
      let watchdog
      let killError
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        clearTimeout(confirmation)
        resolve(value)
      }
      try {
        child = (options.spawn ?? cp.spawn)(
          options.binary ?? require('electron'),
          [prepared.archive],
          {
            env: prepared.env,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
      } catch (error) {
        finish({ code: null, spawnError: String(error), closureConfirmed: true })
        return
      }
      log = fs.createWriteStream(path.join(root, 'electron.log'))
      child.stdout?.pipe(log, { end: false })
      child.stderr?.pipe(log, { end: false })
      let childError
      child.once('error', (error) => {
        childError = String(error)
        if (!child.pid) finish({ code: null, spawnError: childError, closureConfirmed: true })
      })
      child.once('close', (code, signal) =>
        finish({ code, signal, closureConfirmed: true, killError, childError })
      )
      watchdog = setTimeout(() => {
        try {
          if (options.kill) options.kill(child)
          else if (process.platform === 'win32') {
            if (!child.kill('SIGKILL')) throw new Error('kill refused')
          } else process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          killError = String(error)
        }
        confirmation = setTimeout(
          () =>
            finish({
              code: null,
              watchdog: true,
              closureConfirmed: false,
              unresolvedCleanup: true,
              killError,
              childError,
              pid: child.pid
            }),
          options.confirmMs ?? 2000
        )
      }, options.deadlineMs ?? 20000)
    })
  } finally {
    log?.end()
  }
  const resultPath = path.join(prepared.env.TW_DURABILITY_QUALIFICATION_STATE, 'result.json')
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null
  const receipt = {
    ...outcome,
    root,
    sourceSha256: prepared.sourceSha256,
    archiveSha256: prepared.archiveSha256,
    result
  }
  fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  return receipt
}

async function run() {
  if (process.argv[2] !== '--run-exclusive')
    throw new Error(
      'Use --run-exclusive only after root clears adapter review and exclusive helper execution'
    )
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-durability-electron-'))
  const prepared = await prepare(root)
  const receipt = await execute(prepared)
  console.log(JSON.stringify(receipt, null, 2))
  process.exitCode =
    receipt.code === 0 && receipt.closureConfirmed && receipt.result?.status === 'PASS' ? 0 : 1
}

module.exports = { mainSource, isolatedEnvironment, prepare, execute }
if (require.main === module)
  run().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
