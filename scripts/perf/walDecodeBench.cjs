'use strict'

/**
 * Micro-benchmark for workspace-lock WAL replay cost versus WAL size.
 *
 * Bundles src/main/workLocks/WorkspaceLockWal.ts with esbuild (no Electron
 * needed — the module is pure), snapshots the live events.jsonl read-only,
 * and times decodeWorkspaceLockWal() on line-boundary prefixes. Prefixes stay
 * valid because every record chains to the previous one, so any prefix is an
 * internally consistent history.
 *
 * Measured 2026-08-29 on Apple Silicon: ~14 ms per MB, linear — ~1.8 s for a
 * 128 MB / 83k-event WAL. This is the synchronous cost WorkspaceLockAuthority
 * boot() pays inside the awaited WorkspaceLockRuntime.open() before
 * createWindow() on every launch.
 *
 * Usage: node scripts/perf/walDecodeBench.cjs [wal-snapshot.jsonl]
 *   (defaults to snapshotting ~/.taskwraith/workspace-lock-authority-v1/
 *    work-lock-authority/events.jsonl into the OS temp dir)
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')

function snapshotLiveWal() {
  const live = path.join(
    os.homedir(),
    '.taskwraith',
    'workspace-lock-authority-v1',
    'work-lock-authority',
    'events.jsonl'
  )
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wal-bench-')), 'snapshot.jsonl')
  fs.copyFileSync(live, dest)
  return dest
}

function bundleDecoder() {
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wal-bench-')), 'decode.cjs')
  const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild')
  const res = spawnSync(
    esbuild,
    [
      path.join(REPO, 'src', 'main', 'workLocks', 'WorkspaceLockWal.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${outfile}`,
      '--log-level=warning'
    ],
    { stdio: 'inherit' }
  )
  if (res.status !== 0) throw new Error('esbuild bundling failed')
  return outfile
}

function main() {
  const snapshot = process.argv[2] || snapshotLiveWal()
  const { decodeWorkspaceLockWal } = require(bundleDecoder())

  const raw = fs.readFileSync(snapshot, 'utf8')
  const lines = raw.split('\n')
  if (lines[lines.length - 1] !== '') lines.pop() // torn tail from a live append
  const clean = lines.filter(Boolean)
  console.log(
    JSON.stringify({ ev: 'snapshot', lines: clean.length, bytes: Buffer.byteLength(raw) })
  )

  const quarter = Math.floor(clean.length / 4)
  const sizes = [...new Set([quarter, quarter * 2, quarter * 3, clean.length])].filter(Boolean)
  for (const n of sizes) {
    const text = clean.slice(0, n).join('\n') + '\n'
    const bytes = Buffer.byteLength(text)
    const times = []
    let state = null
    for (let i = 0; i < 3; i++) {
      const a = process.hrtime.bigint()
      state = decodeWorkspaceLockWal(text)
      const b = process.hrtime.bigint()
      times.push(Math.round(Number(b - a) / 1e6))
    }
    console.log(
      JSON.stringify({
        ev: 'bench',
        lines: n,
        mb: +(bytes / 1048576).toFixed(1),
        ms: times,
        retained:
          n === clean.length && state
            ? {
                events: state.events.length,
                transitionIds: state.transitionIds.length,
                leaseIds: state.leaseIds.length,
                activeLeases: state.activeLeases.length
              }
            : undefined
      })
    )
  }
  console.log('BENCH DONE')
}

main()
