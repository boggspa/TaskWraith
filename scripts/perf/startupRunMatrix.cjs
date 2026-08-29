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
 * Interpretation caveats, measured 2026-08-29:
 * - The workspace-lock authority root is shared per real OS user
 *   (~/.taskwraith/workspace-lock-authority-v1). Launches contend on its fence
 *   with any live TaskWraith instance: contended runs are bimodal (full WAL
 *   replay, or a degraded fail-fast boot with run/schedule recovery disabled).
 *   Prefer measuring with the dev/release instances quiescent.
 * - An env-var HOME override does NOT isolate that root (or userData):
 *   Electron's app.getPath('home'/'appData') resolves via NSHomeDirectory(),
 *   not $HOME. True isolation needs the authoritative isolated-HOME contract
 *   (scripts/perf/isolatedHome.cjs) or an app-level override for the authority
 *   root, which does not exist today.
 *
 * Usage:
 *   node scripts/perf/startupRunMatrix.cjs --instance-id=perf-startup-<you> \
 *     [--port=9379] [--cold=3] [--warm=5] [--out=/tmp/startup-matrix.jsonl]
 */

const { spawn } = require('child_process')
const fs = require('fs')
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

async function runOnce(kind) {
  if (kind === 'cold') fs.rmSync(profileDir(), { recursive: true, force: true })
  const env = { ...process.env, TASKWRAITH_INSTANCE_ID: instanceId, IOS_REMOTE_TRUE: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const t0 = Date.now()
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: REPO,
    env,
    stdio: 'ignore'
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
  const result = {
    kind,
    t0,
    probeExit,
    devtoolsUpMs: by('devtools-up') ? by('devtools-up').wall - t0 : null,
    windowStartMs: origin ? Math.round(origin - t0) : null,
    dclMs:
      origin && bootReady.sample.nav ? Math.round(origin - t0 + bootReady.sample.nav.dcl) : null,
    fcpMs: origin && fcpEntry ? Math.round(origin - t0 + fcpEntry.t) : null,
    bootReadyMs: bootReady ? bootReady.wall - t0 : null,
    maskGoneMs: by('mask-gone') ? by('mask-gone').wall - t0 : null
  }
  app.kill('SIGTERM')
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(6000)])
  app.kill('SIGKILL')
  await sleep(1500)
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
  const results = []
  for (let i = 0; i < coldRuns; i++) results.push(await runOnce('cold'))
  for (let i = 0; i < warmRuns; i++) results.push(await runOnce('warm'))

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
  console.log('SUMMARY ' + JSON.stringify(summary))
  fs.rmSync(profileDir(), { recursive: true, force: true })
  console.log('MATRIX DONE')
}

main().catch((e) => {
  console.error('matrix failed:', e)
  process.exit(1)
})
