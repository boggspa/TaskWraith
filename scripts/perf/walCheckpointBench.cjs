'use strict'

/**
 * A/B bench for the workspace-lock WAL checkpoint (fix #1).
 *
 * Companion to scripts/perf/walDecodeBench.cjs, which measures the legacy
 * baseline and is deliberately left untouched as the before-evidence. This
 * script answers the acceptance question directly: after checkpointing, does
 * startup decode still scale with the historical payload?
 *
 * It bundles the pure codec modules with esbuild (no Electron needed),
 * snapshots the live events.jsonl read-only, then for each prefix size:
 *   1. times decodeWorkspaceLockWal() on the whole prefix   (legacy boot)
 *   2. plans a compaction and times resolveWorkspaceLockWalState() on the
 *      checkpoint + retained tail                            (checkpointed boot)
 *   3. asserts the two reconstruct the identical authority projection
 *
 * Usage: node scripts/perf/walCheckpointBench.cjs [wal-snapshot.jsonl] [--retain=512]
 *   (defaults to snapshotting ~/.taskwraith/workspace-lock-authority-v1/
 *    work-lock-authority/events.jsonl into the OS temp dir)
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function snapshotLiveWal() {
  const live = path.join(
    os.homedir(),
    '.taskwraith',
    'workspace-lock-authority-v1',
    'work-lock-authority',
    'events.jsonl'
  )
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wal-cp-')), 'snapshot.jsonl')
  fs.copyFileSync(live, dest)
  return dest
}

function bundle(entry, name) {
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wal-cp-')), name)
  const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild')
  const res = spawnSync(
    esbuild,
    [
      entry,
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

function timed(fn, iterations = 3) {
  const times = []
  let value = null
  for (let i = 0; i < iterations; i++) {
    const a = process.hrtime.bigint()
    value = fn()
    const b = process.hrtime.bigint()
    times.push(Math.round(Number(b - a) / 1e6))
  }
  times.sort((x, y) => x - y)
  return { value, ms: times, median: times[(times.length - 1) >> 1] }
}

/**
 * Canonical (key-sorted) stringify. A checkpointed lease round-trips through
 * canonical JSON, so its key ORDER differs from a lease replayed straight from
 * an event even though the content is identical — and the authority only ever
 * compares leases canonically. A plain JSON.stringify would report that as a
 * divergence; this must not.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort())
      if (value[key] !== undefined) out[key] = canonical(value[key])
    return out
  }
  return value
}

/** Compare only what boot actually depends on. */
function projection(state) {
  return JSON.stringify(
    canonical({
      sequence: state.sequence,
      lastDigest: state.lastDigest,
      lastTransitionId: state.lastTransitionId,
      transitionIds: state.transitionIds.length,
      leaseIds: state.leaseIds,
      maxGeneration: state.maxGeneration,
      activeLeases: state.activeLeases,
      recoveredLeases: state.recoveredLeases,
      knownMarkers: state.knownMarkers
    })
  )
}

function main() {
  const snapshot =
    process.argv.find((a) => !a.startsWith('--') && a.endsWith('.jsonl')) || snapshotLiveWal()
  const retain = Number(arg('retain', '512'))
  const codec = require(
    bundle(
      path.join(REPO, 'src', 'main', 'workLocks', 'WorkspaceLockWalCheckpoint.ts'),
      'checkpoint.cjs'
    )
  )
  const { decodeWorkspaceLockWal } = require(
    bundle(path.join(REPO, 'src', 'main', 'workLocks', 'WorkspaceLockWal.ts'), 'decode.cjs')
  )
  const {
    planWorkspaceLockWalCompaction,
    resolveWorkspaceLockWalState,
    decodeWorkspaceLockWalCheckpoint
  } = codec

  const raw = fs.readFileSync(snapshot, 'utf8')
  const lines = raw.split('\n')
  if (lines[lines.length - 1] !== '') lines.pop() // torn tail from a live append
  const clean = lines.filter(Boolean)
  console.log(
    JSON.stringify({
      ev: 'snapshot',
      lines: clean.length,
      bytes: Buffer.byteLength(raw),
      retainedTailEvents: retain
    })
  )

  const quarter = Math.floor(clean.length / 4)
  const sizes = [...new Set([quarter, quarter * 2, quarter * 3, clean.length])].filter(Boolean)
  for (const n of sizes) {
    const text = clean.slice(0, n).join('\n') + '\n'
    const bytes = Buffer.byteLength(text)

    const legacy = timed(() => decodeWorkspaceLockWal(text))
    const plan = planWorkspaceLockWalCompaction({
      state: legacy.value,
      rawTail: text,
      createdAt: '2026-08-29T02:00:00.000Z',
      authority: { instanceId: 'wal-checkpoint-bench', generation: legacy.value.maxGeneration },
      previousCheckpoint: null,
      retainedTailEvents: retain
    })
    if (!plan) {
      console.log(JSON.stringify({ ev: 'skip', lines: n, reason: 'nothing to seal' }))
      continue
    }
    // Exactly what boot does: parse the published checkpoint document, then
    // resolve against the retained tail.
    const checkpointBytes = Buffer.byteLength(plan.serializedCheckpoint)
    const tailBytes = Buffer.byteLength(plan.retainedFrames)
    const checkpointed = timed(() =>
      resolveWorkspaceLockWalState(
        plan.retainedFrames,
        decodeWorkspaceLockWalCheckpoint(plan.serializedCheckpoint)
      )
    )

    const same = projection(legacy.value) === projection(checkpointed.value.state)
    console.log(
      JSON.stringify({
        ev: 'bench',
        lines: n,
        walMb: +(bytes / 1048576).toFixed(1),
        legacyMs: legacy.ms,
        legacyMedianMs: legacy.median,
        checkpointMb: +(checkpointBytes / 1048576).toFixed(2),
        tailKb: +(tailBytes / 1024).toFixed(1),
        checkpointedMs: checkpointed.ms,
        checkpointedMedianMs: checkpointed.median,
        speedup: +(legacy.median / Math.max(checkpointed.median, 1)).toFixed(1),
        identicalProjection: same,
        source: checkpointed.value.source
      })
    )
    if (!same) {
      console.error('FAIL: checkpointed replay did not reconstruct the legacy projection')
      process.exit(1)
    }
  }
  console.log('CHECKPOINT BENCH DONE')
}

main()
