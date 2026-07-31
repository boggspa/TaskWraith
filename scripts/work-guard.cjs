#!/usr/bin/env node
/**
 * work-guard — the between-commits half of the concurrent-work backstop.
 *
 * WHY THIS EXISTS. Everything else that protects this shared checkout is
 * edge-triggered on `git commit`: the pre-commit hook, "raise your marker
 * before your first edit", "drop it in the same breath as your final commit".
 * On 2026-07-30 all three failures happened BETWEEN commits, where none of it
 * runs — one session sat ~11 hours on 8,600 uncommitted lines without a single
 * commit, so the hook was never invoked once, and a visible bug shipped in
 * 1.9.1 because its fix was sitting uncommitted the whole time. That is one
 * bug, not three: there was no clock.
 *
 * This is the clock. Three jobs, none of which asks an agent to remember
 * anything:
 *
 *   1. ORPHAN ALARM   Dirty paths that no LIVE marker claims, reported with
 *                     age. Deliberately needs no attribution — you never have
 *                     to work out whose file it is, only that nobody has
 *                     promised to finish it. That is derivable, and it is the
 *                     check that catches both of the above.
 *
 *   2. SNAPSHOTS      The whole working tree into `refs/wip/`, out of band.
 *                     Makes losing work structurally impossible.
 *
 *   3. HEARTBEAT      A `lastSeen` derived from mtimes of the dirty files a
 *                     marker claims, so a claim survives pid churn and a
 *                     badly-guessed `expires` instead of falsely decaying.
 *
 * Everything here is READ-ONLY with respect to shared state. It never writes
 * the index, the working tree, another session's marker, or any branch, and it
 * never pushes. Local-only by design, so it does NOT belong in the `ci` chain:
 * CI checks out clean and has no sessions or markers to reason about.
 *
 *   node scripts/work-guard.cjs status     human report (default)
 *   node scripts/work-guard.cjs tick       heartbeat + snapshot + prune (timer)
 *   node scripts/work-guard.cjs snapshot   one-shot snapshot
 *   node scripts/work-guard.cjs check      exit 1 on aged orphans (ship gate)
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** A claim whose heartbeat is older than this is no longer self-evidently live. */
const HEARTBEAT_STALE_MS = 20 * 60 * 1000
/** Unclaimed dirty work older than this is what we are actually hunting. */
const ORPHAN_WARN_MS = 45 * 60 * 1000
const SNAPSHOT_KEEP_MS = 7 * 24 * 60 * 60 * 1000
const SNAPSHOT_KEEP_MAX = 300
const SIDECAR_DIR = '.work-guard'
const SIDECAR_FILE = 'heartbeat.json'
const TICK_FILE = 'tick.json'
/**
 * How long before a missing tick means the timer is dead rather than merely
 * between runs. The shipped launchd interval is 300s, so this is four missed
 * ticks — long enough not to cry wolf over a sleeping laptop, short enough
 * that a broken daemon surfaces the same working day.
 */
const TICK_STALE_MS = 20 * 60 * 1000

const MARKER_RE = /^(?:\.WORK-IN-PROGRESS-.+\.md|SHIP-HOLD-.+\.md|SESSION-IN-PROGRESS-.+\.md)$/

// ── git plumbing ────────────────────────────────────────────────────────────

function git(root, args, extraEnv) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function gitQuiet(root, args, extraEnv) {
  try {
    return git(root, args, extraEnv)
  } catch {
    return null
  }
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

/**
 * Dirty paths with their ages. `-z` because filenames may contain anything;
 * rename/copy statuses carry TWO NUL-separated paths and the destination is
 * the one that exists on disk, so the source entry is consumed and dropped.
 */
function dirtyEntries(root) {
  const raw = gitQuiet(root, ['status', '--porcelain', '-z', '--untracked-files=all'])
  if (raw === null) return []
  const fields = raw.split('\0')
  const out = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (!field || field.length < 4) continue
    const status = field.slice(0, 2)
    let file = field.slice(3)
    if (status[0] === 'R' || status[0] === 'C') {
      i += 1 // the following field is the rename SOURCE; the slice above is the destination
    }
    if (!file) continue
    let mtimeMs = null
    try {
      mtimeMs = fs.statSync(path.join(root, file)).mtimeMs
    } catch {
      mtimeMs = null // deleted paths have no mtime; still dirty, just ageless
    }
    out.push({ status, path: file, mtimeMs })
  }
  return out
}

// ── markers ─────────────────────────────────────────────────────────────────

function isMarkerFile(file) {
  return MARKER_RE.test(file)
}

function parseIsoMs(value) {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Claimed paths are written by hand, so they arrive in every shape a human
 * uses: a directory (`src/main/collaboration/`), a glob
 * (`humanCollaborationInvite*.ts`), or a plain file with a trailing
 * parenthetical scope note. Strip the note, keep the rest verbatim.
 */
function normaliseClaim(raw) {
  let claim = raw.trim()
  claim = claim.replace(/\s+\([^)]*\)\s*$/, '')
  claim = claim.replace(/^["']|["']$/g, '')
  return claim.trim()
}

function claimToMatcher(claim) {
  if (claim.endsWith('/')) {
    const prefix = claim
    return (file) => file === claim.slice(0, -1) || file.startsWith(prefix)
  }
  if (claim.includes('*')) {
    const pattern = claim
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')
    const re = new RegExp(`^${pattern}$`)
    return (file) => re.test(file)
  }
  // A bare path may name a file or a directory that has not been given a slash.
  return (file) => file === claim || file.startsWith(`${claim}/`)
}

function parseMarker(root, file) {
  let text
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8')
  } catch {
    return null
  }
  const scalar = (key) => {
    const m = text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))
    if (!m) return null
    // Strip a matched surrounding quote pair, exactly as normaliseClaim already
    // does for list items. TaskWraith's own runtime markers come from a projector
    // whose YAML scalar helper is JSON.stringify, so EVERY scalar arrives quoted
    // — and an unstripped `expires: "2026-…"` parses to NaN, which meant a runtime
    // marker could never decay by clock.
    const value = m[1].trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim()
    return value || null
  }
  const lines = text.split(/\r?\n/)
  const collectList = (key) => {
    const out = []
    let inList = false
    for (const line of lines) {
      if (new RegExp(`^${key}:[ \\t]*$`).test(line)) {
        inList = true
        continue
      }
      if (!inList) continue
      const item = line.match(/^[ \t]*-[ \t]+(.+)$/)
      if (item) {
        const claim = normaliseClaim(item[1])
        if (claim) out.push(claim)
        continue
      }
      if (line.trim() === '') continue
      inList = false
    }
    return out
  }
  const paths = collectList('paths')
  // A runtime marker routes tree leases to `trees:` and workspace leases to
  // `workspaceWide: true`; neither reaches `paths:`. Reading only `paths:` meant a
  // LIVE tree-or-workspace lock claimed nothing, so `work-guard check` reported
  // the app's own files as unclaimed orphans — and a gate that cries wolf is a
  // gate that gets bypassed.
  const trees = collectList('trees')
  const workspaceWide = /^true$/i.test(String(scalar('workspaceWide') || ''))
  const derived = /^true$/i.test(String(scalar('derived') || ''))
  const pidRaw = scalar('pid')
  const pid = pidRaw && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null
  const claims = [...paths, ...trees]
  return {
    file,
    session: scalar('session'),
    agent: scalar('agent'),
    pid,
    expires: scalar('expires'),
    expiresMs: parseIsoMs(scalar('expires')),
    derived,
    workspaceWide,
    paths: claims,
    matchers: workspaceWide ? [() => true] : claims.map(claimToMatcher)
  }
}

function listMarkers(root) {
  let names
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter(isMarkerFile)
    .sort()
    .map((file) => parseMarker(root, file))
    .filter(Boolean)
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to another user — alive.
    return error && error.code === 'EPERM'
  }
}

// ── heartbeat sidecar ───────────────────────────────────────────────────────
//
// Deliberately a sidecar rather than a field inside the marker. The tick runs
// on a timer against markers OTHER sessions own; writing their file would race
// their own edits for no benefit. Absent sidecar data degrades to exactly the
// pre-existing pid+expires rule, so every marker written before this existed
// keeps behaving identically.

function sidecarPath(root) {
  return path.join(root, SIDECAR_DIR, SIDECAR_FILE)
}

function readSidecar(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath(root), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSidecar(root, data) {
  const dir = path.join(root, SIDECAR_DIR)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `.${SIDECAR_FILE}.${process.pid}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    fs.renameSync(tmp, sidecarPath(root))
  } catch {
    // A sidecar we cannot write only costs us the heartbeat upgrade; the
    // pid+expires path still works. Never fail the caller for it.
  }
}

// ── timer liveness ──────────────────────────────────────────────────────────
//
// The tick is silent when healthy, which means a DEAD daemon and a working one
// produce byte-identical evidence: an empty tick.log. A safety net you cannot
// tell is dead is worse than no safety net, because you stop looking. So the
// tick leaves a receipt, and `status` reads it back.

function tickRecordPath(root) {
  return path.join(root, SIDECAR_DIR, TICK_FILE)
}

function readTickRecord(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(tickRecordPath(root), 'utf8'))
    const lastTickMs = Number(parsed?.lastTickMs)
    return Number.isFinite(lastTickMs) ? { lastTickMs } : null
  } catch {
    return null
  }
}

function writeTickRecord(root, now) {
  try {
    fs.mkdirSync(path.join(root, SIDECAR_DIR), { recursive: true })
    const tmp = path.join(root, SIDECAR_DIR, `.${TICK_FILE}.${process.pid}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify({ lastTickMs: now }, null, 2)}\n`)
    fs.renameSync(tmp, tickRecordPath(root))
  } catch {
    /* a receipt we cannot write only costs the staleness report */
  }
}

/**
 * `null` when no tick has ever run — reported differently from "stale", since
 * "never armed" and "armed then died" need different fixes.
 */
function timerHealth(root, now) {
  const record = readTickRecord(root)
  if (!record) return { everRan: false, stale: true, ageMs: null }
  const ageMs = now - record.lastTickMs
  return { everRan: true, stale: ageMs > TICK_STALE_MS, ageMs }
}

/**
 * The launchd plist must not name a VERSIONED interpreter path.
 * `process.execPath` under Homebrew is the Cellar path
 * (`/opt/homebrew/Cellar/node/<version>/bin/node`); `brew upgrade node` deletes
 * that directory and launchd silently stops being able to spawn the job —
 * combined with a silent-when-healthy tick, the daemon dies invisibly. Prefer a
 * stable symlink that resolves to the SAME binary; fall back to execPath when
 * none does, since a working absolute path beats a guessed one.
 */
function stableNodePath(execPath, probe) {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node']
  const target = probe(execPath)
  if (!target) return execPath
  for (const candidate of candidates) {
    if (candidate === execPath) continue
    if (probe(candidate) === target) return candidate
  }
  return execPath
}

function realpathProbe(candidate) {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return null
  }
}

/**
 * The heartbeat is DERIVED, never declared — that is the whole point. Each of
 * today's three marker failures was a false decay:
 *   - pid recorded as `$$`, a subshell that exited immediately;
 *   - pid correct at write time, then the host process died mid-session;
 *   - `expires` guessed too short and never renewed.
 * In all three the session was demonstrably still working, and the proof is on
 * disk: the files it claims keep changing. Taking the newest mtime among a
 * marker's own dirty paths as `lastSeen` survives all three. A live pid also
 * counts, so a session that is thinking rather than typing does not decay.
 */
function advanceHeartbeats(root, markers, dirty, now) {
  const side = readSidecar(root)
  const next = {}
  for (const marker of markers) {
    const claimed = dirty.filter((d) => marker.matchers.some((match) => match(d.path)))
    const newestClaimed = claimed.reduce((acc, d) => Math.max(acc, d.mtimeMs || 0), 0)
    const previous = Number(side[marker.file]?.lastSeen) || 0
    const observed = Math.max(previous, newestClaimed, pidAlive(marker.pid) ? now : 0)
    next[marker.file] = {
      lastSeen: observed || null,
      session: marker.session || null,
      claimedDirty: claimed.length
    }
  }
  writeSidecar(root, next) // entries for vanished markers are dropped by omission
  return next
}

function liveness(marker, side, now) {
  const lastSeen = Number(side[marker.file]?.lastSeen) || null
  const heartbeatFresh = lastSeen !== null && now - lastSeen < HEARTBEAT_STALE_MS
  const alive = pidAlive(marker.pid)
  const expired = marker.expiresMs !== null && now > marker.expiresMs
  return {
    live: heartbeatFresh || (alive && !expired),
    heartbeatFresh,
    alive,
    expired,
    lastSeen
  }
}

// ── snapshots ───────────────────────────────────────────────────────────────

/**
 * Capture the working tree into the object database without touching one byte
 * of shared state.
 *
 * `git stash create` is the obvious primitive and is WRONG here: measured on
 * git 2.49.0 it does not capture untracked files, which is precisely where new
 * work lives. Building a tree through a throwaway GIT_INDEX_FILE captures
 * tracked modifications, another session's staged work, and untracked files,
 * while leaving `.git/index` byte-identical and the working tree untouched.
 * Gitignored paths stay out by construction, so `.local-only/` and the markers
 * never enter the object database.
 */
function takeSnapshot(root, label) {
  const head = gitQuiet(root, ['rev-parse', '--verify', 'HEAD'])
  if (head === null) return { ok: false, reason: 'no HEAD' }
  const tmpIndex = path.join(os.tmpdir(), `work-guard-index-${process.pid}-${Date.now()}`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  try {
    if (gitQuiet(root, ['read-tree', 'HEAD'], env) === null) {
      return { ok: false, reason: 'read-tree failed' }
    }
    if (gitQuiet(root, ['add', '-A'], env) === null) {
      return { ok: false, reason: 'add failed' }
    }
    // Markers are gitignored coordination state, so `-A` skips them — but they
    // are the only record of WHAT a session that died was in the middle of.
    // That context is the difference between a recoverable tree and a pile of
    // anonymous diffs, so force them into the snapshot specifically.
    try {
      const markerFiles = fs.readdirSync(root).filter(isMarkerFile)
      if (markerFiles.length) gitQuiet(root, ['add', '-f', '--', ...markerFiles], env)
    } catch {
      /* the snapshot is still worth taking without them */
    }
    const tree = gitQuiet(root, ['write-tree'], env)
    if (tree === null) return { ok: false, reason: 'write-tree failed' }
    const treeSha = tree.trim()

    // Skip identical trees so an idle machine does not accumulate refs.
    const newest = listSnapshots(root)[0]
    if (newest) {
      const priorTree = gitQuiet(root, ['rev-parse', `${newest.ref}^{tree}`])
      if (priorTree && priorTree.trim() === treeSha) {
        return { ok: true, skipped: true, ref: newest.ref }
      }
    }

    const commit = gitQuiet(root, [
      'commit-tree',
      treeSha,
      '-p',
      head.trim(),
      '-m',
      label || 'work-guard snapshot'
    ])
    if (commit === null) return { ok: false, reason: 'commit-tree failed' }
    // The stamp is second-resolution, so two snapshots inside the same second
    // would resolve to the same ref and the second would silently overwrite the
    // first — losing exactly the work the snapshot exists to hold. The commit
    // sha disambiguates, and it differs whenever the tree does (an identical
    // tree is already short-circuited above).
    const sha = commit.trim()
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    const ref = `refs/wip/${stamp}-${sha.slice(0, 7)}`
    if (gitQuiet(root, ['update-ref', ref, commit.trim()]) === null) {
      return { ok: false, reason: 'update-ref failed' }
    }
    return { ok: true, ref, commit: commit.trim() }
  } finally {
    try {
      fs.rmSync(tmpIndex, { force: true })
    } catch {
      /* best effort */
    }
  }
}

function listSnapshots(root) {
  const raw = gitQuiet(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname) %(committerdate:unix)',
    'refs/wip/'
  ])
  if (!raw) return []
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, unix] = line.split(' ')
      return { ref, atMs: Number(unix) * 1000 }
    })
    .filter((entry) => entry.ref && Number.isFinite(entry.atMs))
}

function pruneSnapshots(root, now) {
  const all = listSnapshots(root)
  const doomed = all.filter(
    (entry, index) => index >= SNAPSHOT_KEEP_MAX || now - entry.atMs > SNAPSHOT_KEEP_MS
  )
  // Always leave the newest standing, whatever the clock says.
  for (const entry of doomed) {
    if (all[0] && entry.ref === all[0].ref) continue
    gitQuiet(root, ['update-ref', '-d', entry.ref])
  }
  return doomed.length
}

// ── evaluation ──────────────────────────────────────────────────────────────

function evaluate(root, now) {
  const markers = listMarkers(root)
  const dirty = dirtyEntries(root)
  const side = readSidecar(root)
  const assessed = markers.map((marker) => ({ marker, state: liveness(marker, side, now) }))
  const liveMarkers = assessed.filter((entry) => entry.state.live).map((entry) => entry.marker)
  const orphans = dirty
    .filter((d) => !isMarkerFile(d.path))
    .filter((d) => !liveMarkers.some((m) => m.matchers.some((match) => match(d.path))))
    .map((d) => ({ ...d, ageMs: d.mtimeMs ? now - d.mtimeMs : null }))
    .sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0))
  return {
    markers: assessed,
    dirty,
    orphans,
    aged: orphans.filter((o) => (o.ageMs || 0) > ORPHAN_WARN_MS)
  }
}

function humanAge(ms) {
  if (ms === null || !Number.isFinite(ms)) return 'unknown age'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h${String(mins % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d`
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdStatus(root, now, { json, hook }) {
  const result = evaluate(root, now)
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          markers: result.markers.map((entry) => ({
            file: entry.marker.file,
            agent: entry.marker.agent,
            pid: entry.marker.pid,
            ...entry.state
          })),
          orphans: result.orphans,
          agedOrphanCount: result.aged.length
        },
        null,
        2
      )}\n`
    )
    return 0
  }

  if (hook) {
    // Terse, advisory, and silent when there is nothing to say — a hook that
    // cries wolf gets disabled, and a disabled hook protects nothing.
    if (result.aged.length) {
      process.stdout.write(
        `  note: ${result.aged.length} dirty path(s) claimed by nobody, oldest ${humanAge(
          result.aged[0].ageMs
        )} — ${result.aged[0].path}\n        \`node scripts/work-guard.cjs status\` lists them.\n`
      )
    }
    // Only worth saying once the timer has been armed at all: on a machine that
    // never loaded it, this is not news and would be pure noise every commit.
    const timer = timerHealth(root, now)
    if (timer.everRan && timer.stale) {
      process.stdout.write(
        `  note: work-guard timer looks dead — last tick ${humanAge(
          timer.ageMs
        )} ago. Snapshots are NOT being taken.\n`
      )
    }
    return 0
  }

  const lines = []
  lines.push('CLAIMS')
  if (!result.markers.length) lines.push('  (none)')
  for (const { marker, state } of result.markers) {
    const why = state.heartbeatFresh
      ? `heartbeat ${humanAge(now - state.lastSeen)} ago`
      : state.alive
        ? `pid ${marker.pid} alive`
        : 'no live signal'
    lines.push(
      `  ${state.live ? 'LIVE   ' : 'DECAYED'} ${marker.file}\n` +
        `          ${marker.agent || 'unknown agent'}\n` +
        `          ${why}${state.expired ? ', expires PASSED' : ''}${
          marker.pid && !state.alive ? `, pid ${marker.pid} dead` : ''
        }`
    )
  }
  lines.push('')
  lines.push(`UNCLAIMED DIRTY PATHS (${result.orphans.length})`)
  if (!result.orphans.length) lines.push('  (none — every dirty path is claimed by a live session)')
  for (const orphan of result.orphans.slice(0, 40)) {
    const flag = (orphan.ageMs || 0) > ORPHAN_WARN_MS ? '  <-- aged' : ''
    lines.push(`  ${orphan.status}  ${humanAge(orphan.ageMs).padStart(7)}  ${orphan.path}${flag}`)
  }
  if (result.orphans.length > 40) lines.push(`  … and ${result.orphans.length - 40} more`)
  const snaps = listSnapshots(root)
  lines.push('')
  lines.push(
    `SNAPSHOTS  ${snaps.length} in refs/wip/${
      snaps.length ? `, newest ${humanAge(now - snaps[0].atMs)} ago (${snaps[0].ref})` : ''
    }`
  )
  const timer = timerHealth(root, now)
  lines.push(
    !timer.everRan
      ? 'TIMER      never run — `node scripts/work-guard.cjs timer` prints the launchd agent'
      : timer.stale
        ? `TIMER      STALE, last tick ${humanAge(timer.ageMs)} ago — NOT snapshotting`
        : `TIMER      healthy, last tick ${humanAge(timer.ageMs)} ago`
  )
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

function cmdTick(root, now) {
  const markers = listMarkers(root)
  const dirty = dirtyEntries(root)
  writeTickRecord(root, now)
  advanceHeartbeats(root, markers, dirty, now)
  const label = `work-guard snapshot — ${dirty.length} dirty, ${markers.length} claim(s)`
  const snap = takeSnapshot(root, label)
  pruneSnapshots(root, now)
  const result = evaluate(root, now)
  // A timer that chatters gets muted, so speak only when something is wrong.
  if (result.aged.length) {
    process.stdout.write(
      `work-guard: ${result.aged.length} unclaimed dirty path(s), oldest ${humanAge(
        result.aged[0].ageMs
      )} (${result.aged[0].path})${snap.ok && snap.ref ? ` — snapshot ${snap.ref}` : ''}\n`
    )
  }
  return 0
}

function cmdCheck(root, now) {
  const result = evaluate(root, now)
  if (!result.aged.length) {
    process.stdout.write('work-guard: no aged unclaimed work.\n')
    return 0
  }
  process.stderr.write(
    `work-guard: ${result.aged.length} dirty path(s) older than ${Math.round(
      ORPHAN_WARN_MS / 60000
    )}m that no live claim covers:\n`
  )
  for (const orphan of result.aged.slice(0, 20)) {
    process.stderr.write(`  ${humanAge(orphan.ageMs).padStart(7)}  ${orphan.path}\n`)
  }
  process.stderr.write('Commit it, claim it, or confirm it is disposable before shipping.\n')
  return 1
}

/**
 * Emit a launchd agent for `tick`.
 *
 * Printed rather than written into the repo: the plist has to name an absolute
 * repo path and an absolute node path, and this repository is public. Generate
 * it, redirect it somewhere gitignored, and load it by hand — a background
 * agent on someone's machine should be an explicit act, not a side effect of
 * checking out a branch.
 */
function cmdTimer(root) {
  const label = 'com.taskwraith.work-guard'
  const nodeBin = stableNodePath(process.execPath, realpathProbe)
  const logDir = path.join(root, SIDECAR_DIR)
  process.stdout.write(
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${path.join(root, 'scripts', 'work-guard.cjs')}</string>
    <string>tick</string>
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${path.join(logDir, 'tick.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'tick.log')}</string>
</dict>
</plist>
`
  )
  return 0
}

function main(argv) {
  const args = argv.slice(2)
  const command = args.find((a) => !a.startsWith('-')) || 'status'
  const json = args.includes('--json')
  const hook = args.includes('--hook')
  const root = repoRoot()
  if (!root) {
    if (hook) return 0
    process.stderr.write('work-guard: not inside a git repository.\n')
    return hook ? 0 : 1
  }
  const now = Date.now()
  switch (command) {
    case 'status':
      return cmdStatus(root, now, { json, hook })
    case 'tick':
      return cmdTick(root, now)
    case 'snapshot': {
      const snap = takeSnapshot(root, 'work-guard snapshot (manual)')
      process.stdout.write(
        snap.ok
          ? snap.skipped
            ? `work-guard: tree unchanged since ${snap.ref}\n`
            : `work-guard: ${snap.ref}\n`
          : `work-guard: snapshot failed (${snap.reason})\n`
      )
      return snap.ok ? 0 : 1
    }
    case 'check':
      return cmdCheck(root, now)
    case 'timer':
      return cmdTimer(root)
    default:
      process.stderr.write(`work-guard: unknown command '${command}'\n`)
      return 1
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv)
}

module.exports = {
  HEARTBEAT_STALE_MS,
  ORPHAN_WARN_MS,
  claimToMatcher,
  normaliseClaim,
  parseMarker,
  liveness,
  evaluate,
  takeSnapshot,
  listSnapshots,
  pruneSnapshots,
  SNAPSHOT_KEEP_MS,
  TICK_STALE_MS,
  timerHealth,
  writeTickRecord,
  stableNodePath,
  isMarkerFile
}
