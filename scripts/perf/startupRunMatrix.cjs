'use strict'

/**
 * Repeated cold/warm launch matrix for startup milestones. Spawns an isolated
 * TaskWraith instance per run (unique TASKWRAITH_INSTANCE_ID + debug port, per
 * .claude/skills/verify/SKILL.md), drives scripts/perf/startupMilestoneProbe.cjs
 * against it, and emits one JSON line per run plus a median/min/max summary.
 *
 * "cold" deletes the instance's userData profile before launching (fresh
 * profile, NOT an OS-cold filesystem cache). "warm" reuses it.
 *
 * Each run captures failure diagnostics: the main-process stdout/stderr log
 * (<out>.runN.<kind>.log), app exit status, DevTools inspector state when the
 * run fails, and a structured failureClass —
 *   boot-ready | boot-ready-degraded | no-boot-ready | wedged-no-window |
 *   app-exited-early
 * plus signature flags separating distinct failures: recovery-disabled boots
 * ("startup recovery failed; run and schedule recovery remain disabled"),
 * WAL identity/revision append conflicts, and WorkspaceLockAuthorityBusyError.
 *
 * Interpretation caveats, measured 2026-08-29:
 * - The workspace-lock authority root is shared per real OS user
 *   (~/.taskwraith/workspace-lock-authority-v1). Launches contend on its fence
 *   with any live TaskWraith instance: contended runs are bimodal (full WAL
 *   replay, or a degraded fail-fast boot with run/schedule recovery disabled).
 *   Prefer measuring with the dev/release instances quiescent.
 * - An env-var HOME override does NOT isolate that root (or userData):
 *   Electron's app.getPath('home'/'appData') resolves via NSHomeDirectory(),
 *   not $HOME. Pass --authority-root=<absolute path> to use the app-level,
 *   test-only override instead (TASKWRAITH_WORKSPACE_LOCK_AUTHORITY_ROOT; see
 *   src/main/startup/WorkspaceLockAuthorityRootOverride.ts). It is fail-closed:
 *   a packaged build, a relative path, or a value that resolves back to the
 *   shared root all refuse to launch rather than silently measuring the shared
 *   root, which is exactly how an earlier "WAL-free" control run lied.
 *
 * Usage:
 *   node scripts/perf/startupRunMatrix.cjs --instance-id=perf-startup-<you> \
 *     [--port=9379] [--cold=3] [--warm=5] [--out=/tmp/startup-matrix.jsonl] \
 *     [--authority-root=/abs/path] [--seed-wal=<file.jsonl>]
 */

const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const ELECTRON = path.join(REPO, 'node_modules', '.bin', 'electron')
const PROBE = path.join(__dirname, 'startupMilestoneProbe.cjs')

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const instanceId = arg('instance-id', '')
const port = Number(arg('port', '9379'))
const coldRuns = Number(arg('cold', '3'))
const warmRuns = Number(arg('warm', '5'))
const outFile = arg('out', '/tmp/startup-matrix.jsonl')
const authorityRoot = arg('authority-root', '')
const seedWal = arg('seed-wal', '')

if (authorityRoot && !path.isAbsolute(authorityRoot)) {
  console.error('--authority-root must be an absolute path.')
  process.exit(1)
}
if (seedWal && !authorityRoot) {
  console.error('--seed-wal requires --authority-root (never seed the shared root).')
  process.exit(1)
}

/**
 * Plants a known WAL into the isolated authority root so a run measures a
 * chosen history size rather than whatever the machine happens to hold. Only
 * ever writes inside --authority-root.
 */
function seedAuthorityRoot() {
  if (!authorityRoot) return null
  const dir = path.join(authorityRoot, 'work-lock-authority')
  // Only --seed-wal wipes. Without it the existing root is measured as-is,
  // which is how an "after checkpoint" run is compared against its own "before".
  if (seedWal) fs.rmSync(authorityRoot, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!seedWal) return { reused: true, ...authorityRootShape() }
  const raw = fs.readFileSync(seedWal, 'utf8')
  fs.writeFileSync(path.join(dir, 'events.jsonl'), raw, { mode: 0o600 })
  return { bytes: Buffer.byteLength(raw), events: raw.split('\n').filter(Boolean).length }
}

/** Post-run journal shape, so a report can state what was actually measured. */
function authorityRootShape() {
  if (!authorityRoot) return null
  const dir = path.join(authorityRoot, 'work-lock-authority')
  const stat = (name) => {
    try {
      return fs.statSync(path.join(dir, name)).size
    } catch {
      return null
    }
  }
  let archive = []
  try {
    archive = fs.readdirSync(path.join(dir, 'archive'))
  } catch {
    archive = []
  }
  return {
    eventsBytes: stat('events.jsonl'),
    checkpointBytes: stat('checkpoint.json'),
    archiveSegments: archive.length
  }
}

if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,80}$/.test(instanceId) || instanceId === 'verify') {
  console.error(
    'Pass --instance-id=<unique id> (not "verify"; see .claude/skills/verify/SKILL.md).'
  )
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// devAppName truncates the instance id to 16 chars for the app/profile name.
function profileDir() {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    `TaskWraith Dev ${instanceId.slice(0, 16)}`
  )
}

function inspectorState() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 1500 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve({ reachable: true, targetCount: JSON.parse(body).length })
        } catch {
          resolve({ reachable: true, targetCount: null })
        }
      })
    })
    req.on('error', () => resolve({ reachable: false }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ reachable: false, timedOut: true })
    })
  })
}

// Distinct failure signatures; a degraded boot is not necessarily the same
// failure as an identity conflict or a busy authority.
function classifyLog(logText) {
  return {
    recoveryDisabled:
      /startup recovery failed \(|startup recovery failed; run and schedule recovery remain disabled/.test(
        logText
      ),
    walIdentityConflict: /WAL changed identity or revision/.test(logText),
    authorityBusy: /WorkspaceLockAuthorityBusyError|is committing a workspace-lock transition/.test(
      logText
    ),
    // Post-checkpoint signals: which replay path boot actually took, and
    // whether the deferred compaction ran.
    authorityRootOverride: /TEST-ONLY authority root override in use/.test(logText),
    compacted: /\[workspace-lock\] sealed \d+ frames/.test(logText),
    recoveredAfterRetry: /Workspace locking is available again/.test(logText)
  }
}

async function runOnce(kind, runIndex) {
  if (kind === 'cold') fs.rmSync(profileDir(), { recursive: true, force: true })
  const env = { ...process.env, TASKWRAITH_INSTANCE_ID: instanceId, IOS_REMOTE_TRUE: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  if (authorityRoot) env.TASKWRAITH_WORKSPACE_LOCK_AUTHORITY_ROOT = authorityRoot
  const logPath = `${outFile.replace(/\.jsonl$/, '')}.run${runIndex}.${kind}.log`
  const logFd = fs.openSync(logPath, 'w')
  const t0 = Date.now()
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: REPO,
    env,
    stdio: ['ignore', logFd, logFd]
  })
  let appExit = null
  let killSent = false
  app.on('exit', (code, signal) => {
    appExit = { code, signal, wallMs: Date.now() - t0, beforeKill: !killSent }
  })
  const probe = spawn('node', [PROBE, String(port), '150000'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  probe.stdout.on('data', (d) => (stdout += d))
  const probeExit = await new Promise((res) => probe.on('exit', res))
  const events = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const by = (ev) => events.find((e) => e.ev === ev)
  const bootReady = by('boot-ready')
  const origin = bootReady && bootReady.sample ? bootReady.sample.timeOrigin : null
  const fcpEntry =
    bootReady && bootReady.sample && Array.isArray(bootReady.sample.paint)
      ? bootReady.sample.paint.find((x) => x.n === 'first-contentful-paint')
      : null
  const inspector = bootReady ? null : await inspectorState()
  killSent = true
  if (!appExit) {
    app.kill('SIGTERM')
    await Promise.race([new Promise((r) => app.on('exit', r)), sleep(6000)])
    app.kill('SIGKILL')
  }
  await sleep(1500)
  fs.closeSync(logFd)
  const logText = fs.readFileSync(logPath, 'utf8')
  const signatures = classifyLog(logText)
  let failureClass
  if (appExit && appExit.beforeKill) failureClass = 'app-exited-early'
  else if (bootReady && signatures.recoveryDisabled) failureClass = 'boot-ready-degraded'
  else if (bootReady) failureClass = 'boot-ready'
  else if (!by('page-target')) failureClass = 'wedged-no-window'
  else failureClass = 'no-boot-ready'
  const result = {
    kind,
    t0,
    probeExit,
    failureClass,
    signatures,
    appExit,
    inspector,
    logPath,
    authority: authorityRootShape(),
    devtoolsUpMs: by('devtools-up') ? by('devtools-up').wall - t0 : null,
    windowStartMs: origin ? Math.round(origin - t0) : null,
    dclMs:
      origin && bootReady.sample.nav ? Math.round(origin - t0 + bootReady.sample.nav.dcl) : null,
    fcpMs: origin && fcpEntry ? Math.round(origin - t0 + fcpEntry.t) : null,
    bootReadyMs: bootReady ? bootReady.wall - t0 : null,
    maskGoneMs: by('mask-gone') ? by('mask-gone').wall - t0 : null
  }
  fs.appendFileSync(outFile, JSON.stringify(result) + '\n')
  console.log(JSON.stringify(result))
  return result
}

function agg(rows, key) {
  const v = rows
    .map((r) => r[key])
    .filter((x) => typeof x === 'number')
    .sort((a, b) => a - b)
  if (!v.length) return null
  const median =
    v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2)
  return { n: v.length, median, min: v[0], max: v[v.length - 1] }
}

async function main() {
  fs.writeFileSync(outFile, '')
  const seeded = seedAuthorityRoot()
  if (seeded) {
    console.log(JSON.stringify({ ev: 'authority-root', path: authorityRoot, seeded }))
  }
  const results = []
  let runIndex = 0
  for (let i = 0; i < coldRuns; i++) results.push(await runOnce('cold', runIndex++))
  for (let i = 0; i < warmRuns; i++) results.push(await runOnce('warm', runIndex++))

  const summary = {}
  for (const kind of ['cold', 'warm']) {
    const rows = results.filter((r) => r.kind === kind)
    if (!rows.length) continue
    summary[kind] = {
      windowStartMs: agg(rows, 'windowStartMs'),
      bootReadyMs: agg(rows, 'bootReadyMs'),
      maskGoneMs: agg(rows, 'maskGoneMs')
    }
  }
  const failureClasses = {}
  for (const r of results)
    failureClasses[r.failureClass] = (failureClasses[r.failureClass] || 0) + 1
  summary.failureClasses = failureClasses
  summary.authorityRoot = authorityRoot || '(shared per-user root)'
  summary.authority = authorityRootShape()
  console.log('SUMMARY ' + JSON.stringify(summary))
  fs.rmSync(profileDir(), { recursive: true, force: true })
  console.log('MATRIX DONE')
}

main().catch((e) => {
  console.error('matrix failed:', e)
  process.exit(1)
})
