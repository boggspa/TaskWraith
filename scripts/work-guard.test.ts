import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Marker = {
  file: string
  task?: string | null
  worktree?: string | null
  pid: number | null
  /** A sandboxed seat's identity, present when it had no pid to record. */
  lockOwnerId: string | null
  expiresMs: number | null
  paths: string[]
  matchers: ((file: string) => boolean)[]
}

type Liveness = {
  live: boolean
  heartbeatFresh: boolean
  alive: boolean
  expired: boolean
  lastSeen: number | null
}

const {
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
  dirtyEntries,
  advanceHeartbeats,
  MAX_LEASE_MS
} = require('./work-guard.cjs') as {
  HEARTBEAT_STALE_MS: number
  ORPHAN_WARN_MS: number
  claimToMatcher: (claim: string) => (file: string) => boolean
  normaliseClaim: (raw: string) => string
  parseMarker: (root: string, file: string) => Marker | null
  liveness: (marker: Marker, side: Record<string, unknown>, now: number) => Liveness
  evaluate: (
    root: string,
    now: number
  ) => {
    markers: { marker: Marker; state: Liveness }[]
    orphans: { path: string; ageMs: number | null }[]
    aged: { path: string; ageMs: number | null }[]
  }
  takeSnapshot: (root: string, label?: string) => { ok: boolean; ref?: string; skipped?: boolean }
  listSnapshots: (root: string) => { ref: string; atMs: number }[]
  pruneSnapshots: (root: string, now: number) => number
  SNAPSHOT_KEEP_MS: number
  TICK_STALE_MS: number
  timerHealth: (
    root: string,
    now: number
  ) => {
    everRan: boolean
    stale: boolean
    ageMs: number | null
    node: string | null
    parseOk: true | null
  }
  writeTickRecord: (root: string, now: number) => void
  stableNodePath: (execPath: string, probe: (p: string) => string | null) => string
  dirtyEntries: (root: string) => Array<{ path: string; status: string; mtimeMs: number | null }>
  advanceHeartbeats: (
    root: string,
    markers: Marker[],
    dirty: Array<{ path: string; status: string; mtimeMs: number | null }>,
    now: number
  ) => any
}

const DEAD_PID = 2147483646 // far above any real pid; process.kill(_, 0) must reject
const NOW = 1_800_000_000_000
const repos: string[] = []

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'work-guard-test-'))
  repos.push(root)
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  run(['init', '-q', '.'])
  run(['config', 'user.email', 'guard@test'])
  run(['config', 'user.name', 'guard'])
  run(['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'seed.ts'), 'export const seed = 1\n')
  run(['add', '-A'])
  run(['commit', '-qm', 'seed'])
  return root
}

function writeMarker(
  root: string,
  slug: string,
  options: {
    pid: number | null
    expires: string
    paths: string[]
    /** A sandboxed seat's identity, used when it has no pid to record. */
    lockOwnerId?: string
    /**
     * Defaults to NOW. A lease is capped at MAX_LEASE_MS from this, so a
     * fixture without one cannot hold a lease longer than the ceiling.
     */
    started?: string
  }
): string {
  const file = `.WORK-IN-PROGRESS-${slug}.md`
  const pidLine = options.pid === null ? '' : `pid: ${options.pid}\n`
  const ownerLine = options.lockOwnerId ? `lockOwnerId: ${options.lockOwnerId}\n` : ''
  const startedLine = `started: ${options.started ?? iso(NOW)}\n`
  writeFileSync(
    join(root, file),
    `---\nsession: test-${slug}\nagent: test agent\n${pidLine}${ownerLine}${startedLine}expires: ${options.expires}\npaths:\n${options.paths
      .map((p) => `  - ${p}\n`)
      .join('')}---\nbody\n`
  )
  return file
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

/** Marker + sidecar shape the liveness rule consumes. */
function markerFor(root: string, file: string): Marker {
  const parsed = parseMarker(root, file)
  expect(parsed, `parseMarker(${file})`).not.toBeNull()
  return parsed as Marker
}

afterEach(() => {
  while (repos.length) {
    const root = repos.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('claim matching', () => {
  it('strips the trailing scope note humans write beside a path', () => {
    // Real markers in this repo carry them, e.g.
    //   - src/main/services/ChatService.ts        (collaboration teardown only)
    expect(normaliseClaim('src/main/services/ChatService.ts   (teardown only)')).toBe(
      'src/main/services/ChatService.ts'
    )
    expect(normaliseClaim('  scripts/work-guard.cjs            (new)  ')).toBe(
      'scripts/work-guard.cjs'
    )
    expect(normaliseClaim("'quoted/path.ts'")).toBe('quoted/path.ts')
    expect(normaliseClaim(JSON.stringify('quoted/"path".ts'))).toBe('quoted/"path".ts')
  })

  it('matches directories, globs and plain files', () => {
    expect(claimToMatcher('src/main/collaboration/')('src/main/collaboration/Deep.ts')).toBe(true)
    expect(claimToMatcher('src/main/collaboration/')('src/main/collaboration')).toBe(true)
    expect(claimToMatcher('src/lib/invite*.ts')('src/lib/inviteCodec.ts')).toBe(true)
    expect(claimToMatcher('scripts/work-guard.cjs')('scripts/work-guard.cjs')).toBe(true)
    expect(claimToMatcher('scripts')('scripts/nested/file.ts')).toBe(true)
  })

  it('does not over-match a neighbouring path', () => {
    // The whole value of the alarm is that an unclaimed file stays unclaimed;
    // a matcher that swallows siblings would silently protect nothing.
    expect(claimToMatcher('scripts/work-guard.cjs')('scripts/work-guard-other.cjs')).toBe(false)
    expect(claimToMatcher('src/main/collaboration/')('src/main/collaboration-extra/A.ts')).toBe(
      false
    )
    expect(claimToMatcher('src/lib/invite*.ts')('src/lib/nested/inviteCodec.ts')).toBe(false)
  })
})

describe('liveness — backward compatibility', () => {
  it('with no sidecar entry, reduces to exactly the pre-existing pid+expires rule', () => {
    // Load-bearing: markers written before work-guard existed carry no
    // heartbeat, and one of them is live in the real checkout right now. If
    // this drifts, an in-flight session's claim silently changes meaning.
    const root = makeRepo()
    const live = markerFor(
      root,
      writeMarker(root, 'live', {
        pid: process.pid,
        expires: iso(NOW + 60_000),
        paths: ['src/']
      })
    )
    const expiredMarker = markerFor(
      root,
      writeMarker(root, 'expired', {
        pid: process.pid,
        expires: iso(NOW - 60_000),
        paths: ['src/']
      })
    )
    const deadMarker = markerFor(
      root,
      writeMarker(root, 'dead', { pid: DEAD_PID, expires: iso(NOW + 60_000), paths: ['src/'] })
    )

    expect(liveness(live, {}, NOW).live).toBe(true)
    expect(liveness(expiredMarker, {}, NOW).live).toBe(false)
    expect(liveness(deadMarker, {}, NOW).live).toBe(false)
  })
})

describe('liveness — an owner-id-only seat claim has no pid', () => {
  // A seat using the narrow per-seat identity authenticates with the
  // TASKWRAITH_LOCK_OWNER_ID it carries in its environment, and
  // `.githooks/pre-commit` BLOCKS on that claim. This tool must agree. A
  // separately verified stable-PID fallback uses the ordinary pid lane above.
  //
  // Measured before this lane existed: a marker the hook was actively blocking
  // on reported live:false here, and its own claimed paths were simultaneously
  // listed as unclaimed. That is not a cosmetic split — AGENTS.md defines a
  // decayed claim as ADOPTABLE, so the reader is told to harvest its paths and
  // delete it, and `work-guard:check` exits 1 on the claim's own files.

  it('treats an unexpired owner-id claim as live with no pid at all', () => {
    const root = makeRepo()
    const seat = markerFor(
      root,
      writeMarker(root, 'seat', {
        pid: null,
        lockOwnerId: 'seat-owner-1',
        expires: iso(NOW + 3_600_000),
        paths: ['src/']
      })
    )
    const result = liveness(seat, {}, NOW)
    expect(result.live).toBe(true)
    expect(result.alive).toBe(false)
    expect(result.ownerHeld).toBe(true)
  })

  it('is born live — before the seat has dirtied a single claimed path', () => {
    // Doctrine says raise the claim BEFORE the first edit to a clean file. The
    // derived heartbeat reads mtimes of DIRTY claimed paths, so at that moment
    // there is nothing to derive from. The pid lane had a live pid to fall back
    // on; this lane has only the lease, which is exactly why it must count.
    const root = makeRepo()
    const seat = markerFor(
      root,
      writeMarker(root, 'seat-clean', {
        pid: null,
        lockOwnerId: 'seat-owner-2',
        expires: iso(NOW + 3_600_000),
        paths: ['src/untouched.ts']
      })
    )
    expect(liveness(seat, {}, NOW).live).toBe(true)
  }, 30_000)

  it('decays on expiry, because the lease is its only decay signal', () => {
    const root = makeRepo()
    const seat = markerFor(
      root,
      writeMarker(root, 'seat-expired', {
        pid: null,
        lockOwnerId: 'seat-owner-3',
        expires: iso(NOW - 60_000),
        paths: ['src/']
      })
    )
    expect(liveness(seat, {}, NOW).live).toBe(false)
  })

  it('caps a lease at 15 minutes from started, however far off expires is', () => {
    const root = makeRepo()
    const stale = markerFor(
      root,
      writeMarker(root, 'seat-2099', {
        pid: null,
        lockOwnerId: 'seat-owner-5',
        started: iso(NOW - 20 * 60_000),
        expires: '2099-01-01T00:00:00Z',
        paths: ['src/']
      })
    )
    expect(liveness(stale, {}, NOW).live).toBe(false)
  })

  it('holds a claim still inside the ceiling', () => {
    const root = makeRepo()
    const fresh = markerFor(
      root,
      writeMarker(root, 'seat-fresh', {
        pid: null,
        lockOwnerId: 'seat-owner-6',
        started: iso(NOW - 5 * 60_000),
        expires: '2099-01-01T00:00:00Z',
        paths: ['src/']
      })
    )
    expect(liveness(fresh, {}, NOW).live).toBe(true)
  })

  it('cannot bound an over-long lease with no readable started, so it does not hold', () => {
    const root = makeRepo()
    const file = '.WORK-IN-PROGRESS-unbounded.md'
    writeFileSync(
      join(root, file),
      `---\nlockOwnerId: seat-owner-7\nexpires: 2099-01-01T00:00:00Z\npaths:\n  - src/\n---\nbody\n`
    )
    expect(liveness(markerFor(root, file), {}, NOW).live).toBe(false)
  })

  it('keeps the ceiling identical to the git hook, which is the blocking authority', () => {
    // These two tools reason about the same marker from different sides. When
    // they drifted on 2026-08-06 the hook BLOCKED on a claim this tool called
    // decayed — and AGENTS.md tells the next agent a decayed claim is theirs to
    // harvest and delete. A silent constant drift would reopen exactly that.
    const hook = readFileSync(join(__dirname, '..', '.githooks', 'pre-commit'), 'utf8')
    const declared = hook.match(/^MAX_LEASE_SECONDS=(\d+)$/m)
    expect(declared, 'MAX_LEASE_SECONDS not found in .githooks/pre-commit').not.toBeNull()
    expect(Number(declared?.[1]) * 1000).toBe(MAX_LEASE_MS)
  })

  it('never reads a claim field out of the prose body', () => {
    // A marker's body routinely discusses these keys — one describing this very
    // mechanism names `lockOwnerId:` in a sentence. Before the frontmatter gate
    // that text parsed as a real field, which under the owner-id lane would
    // have kept a claim live indefinitely after its pid died. The hook was
    // never exposed to this; its awk gates on the block.
    const root = makeRepo()
    const file = '.WORK-IN-PROGRESS-prose.md'
    writeFileSync(
      join(root, file),
      [
        '---',
        'session: real',
        `pid: ${DEAD_PID}`,
        `expires: ${iso(NOW + 3_600_000)}`,
        'paths:',
        '  - src/real.ts',
        '---',
        'Body prose, not a claim:',
        'lockOwnerId: not-a-real-owner',
        'paths:',
        '  - src/never-claimed.ts'
      ].join('\n')
    )
    const marker = markerFor(root, file)
    expect(marker.lockOwnerId).toBeNull()
    expect(marker.paths).toEqual(['src/real.ts'])
    // Dead pid, no real owner id: the body must not resurrect it.
    expect(liveness(marker, {}, NOW).live).toBe(false)
  })

  it('decays when the lease is missing entirely, so a seat cannot hold forever', () => {
    const root = makeRepo()
    const file = '.WORK-IN-PROGRESS-seat-leaseless.md'
    writeFileSync(
      join(root, file),
      '---\nsession: test\nagent: test agent\nlockOwnerId: seat-owner-4\npaths:\n  - src/\n---\nbody\n'
    )
    const seat = markerFor(root, file)
    expect(seat.expiresMs).toBeNull()
    expect(liveness(seat, {}, NOW).live).toBe(false)
  })
})

describe('liveness — the three ways markers failed on 2026-07-30', () => {
  const freshSide = (file: string): Record<string, unknown> => ({
    [file]: { lastSeen: NOW - 60_000 }
  })

  it('survives a pid recorded from a subshell that has already exited', () => {
    const root = makeRepo()
    const marker = markerFor(
      root,
      writeMarker(root, 'subshell-pid', {
        pid: DEAD_PID,
        expires: iso(NOW + 3_600_000),
        paths: ['src/']
      })
    )
    expect(liveness(marker, {}, NOW).live).toBe(false)
    expect(liveness(marker, freshSide(marker.file), NOW).live).toBe(true)
  })

  it('survives the host process dying and the session continuing under a new pid', () => {
    const root = makeRepo()
    const marker = markerFor(
      root,
      writeMarker(root, 'host-died', {
        pid: DEAD_PID,
        expires: iso(NOW + 3_600_000),
        paths: ['src/']
      })
    )
    expect(liveness(marker, freshSide(marker.file), NOW).heartbeatFresh).toBe(true)
    expect(liveness(marker, freshSide(marker.file), NOW).live).toBe(true)
  })

  it('survives an `expires` guessed too short and never renewed', () => {
    const root = makeRepo()
    const marker = markerFor(
      root,
      writeMarker(root, 'under-guessed', {
        pid: DEAD_PID,
        expires: iso(NOW - 3_600_000),
        paths: ['src/']
      })
    )
    expect(liveness(marker, {}, NOW).live).toBe(false)
    const state = liveness(marker, freshSide(marker.file), NOW)
    expect(state.expired).toBe(true)
    expect(state.live).toBe(true)
  })

  it('still decays once the heartbeat goes stale, so a claim cannot freeze the tree forever', () => {
    // The failure direction that matters in the other sense: if a heartbeat
    // never went stale, an abandoned claim would block adoption indefinitely.
    const root = makeRepo()
    const marker = markerFor(
      root,
      writeMarker(root, 'abandoned', {
        pid: DEAD_PID,
        expires: iso(NOW - 3_600_000),
        paths: ['src/']
      })
    )
    const stale = { [marker.file]: { lastSeen: NOW - HEARTBEAT_STALE_MS - 1000 } }
    expect(liveness(marker, stale, NOW).live).toBe(false)
  })
})

describe('orphan alarm', () => {
  it('flags dirty work no live claim covers, and reports its age', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'orphan.ts'), 'export const orphan = 1\n')
    const old = (NOW - 3 * 60 * 60 * 1000) / 1000
    utimesSync(join(root, 'src', 'orphan.ts'), old, old)

    const result = evaluate(root, NOW)
    const paths = result.orphans.map((o) => o.path)
    expect(paths).toContain('src/orphan.ts')
    expect(result.aged.map((o) => o.path)).toContain('src/orphan.ts')
    const orphan = result.orphans.find((o) => o.path === 'src/orphan.ts')
    expect(orphan?.ageMs).toBeGreaterThan(ORPHAN_WARN_MS)
  }, 30_000)

  it('stays silent when a live claim covers the work', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'claimed.ts'), 'export const claimed = 1\n')
    writeMarker(root, 'owner', {
      pid: process.pid,
      expires: iso(Date.now() + 3_600_000),
      paths: ['src/']
    })
    const result = evaluate(root, Date.now())
    expect(result.orphans.map((o) => o.path)).not.toContain('src/claimed.ts')
  })

  it('does not let a marker for another declared worktree cover this checkout', () => {
    const root = makeRepo()
    const otherRoot = join(root, 'other-worktree')
    mkdirSync(otherRoot)
    writeFileSync(join(root, 'src', 'claimed.ts'), 'export const claimed = 1\n')
    const file = writeMarker(root, 'other-worktree', {
      pid: process.pid,
      expires: iso(Date.now() + 3_600_000),
      paths: ['src/']
    })
    const markerPath = join(root, file)
    writeFileSync(
      markerPath,
      readFileSync(markerPath, 'utf8').replace(
        'agent: test agent\n',
        `agent: test agent\nworktree: ${otherRoot}\n`
      )
    )

    const result = evaluate(root, Date.now())
    expect(result.orphans.map((o) => o.path)).toContain('src/claimed.ts')
  })

  it('does not invoke repository fsmonitor code while checking dirty paths', () => {
    if (process.platform === 'win32') return
    const root = makeRepo()
    const sentinel = join(root, 'fsmonitor-invoked')
    const hook = join(root, '.git', 'fsmonitor-probe.sh')
    writeFileSync(hook, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 1\n`)
    chmodSync(hook, 0o755)
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: root })
    writeFileSync(join(root, 'src', 'claimed.ts'), 'export const claimed = 1\n')

    expect(evaluate(root, Date.now()).orphans.map((entry) => entry.path)).toContain(
      'src/claimed.ts'
    )
    expect(existsSync(sentinel)).toBe(false)
  })

  it('flags work whose only claim has DECAYED — an abandoned promise protects nothing', () => {
    // This is the Codex case: a session stops, its claim rots, and 8,600 lines
    // sit uncommitted looking owned.
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'stranded.ts'), 'export const stranded = 1\n')
    writeMarker(root, 'gone', {
      pid: DEAD_PID,
      expires: iso(Date.now() - 3_600_000),
      paths: ['src/']
    })
    const result = evaluate(root, Date.now())
    expect(result.orphans.map((o) => o.path)).toContain('src/stranded.ts')
  })

  it('never counts the marker files themselves as orphans', () => {
    const root = makeRepo()
    writeMarker(root, 'self', {
      pid: process.pid,
      expires: iso(Date.now() + 3_600_000),
      paths: ['src/']
    })
    const result = evaluate(root, Date.now())
    expect(result.orphans.map((o) => o.path).filter((p) => p.includes('WORK-IN-PROGRESS'))).toEqual(
      []
    )
  })
})

describe('timer liveness', () => {
  it('distinguishes never-armed from armed-then-died', () => {
    // These need different fixes — "load the agent" vs "your agent is broken" —
    // and conflating them sends you down the wrong path.
    const root = makeRepo()
    expect(timerHealth(root, NOW).everRan).toBe(false)

    writeTickRecord(root, NOW - 60_000)
    const fresh = timerHealth(root, NOW)
    expect(fresh.everRan).toBe(true)
    expect(fresh.stale).toBe(false)
    expect(fresh.node).toBe(process.version)
    expect(fresh.parseOk).toBe(true)

    writeTickRecord(root, NOW - TICK_STALE_MS - 1000)
    const dead = timerHealth(root, NOW)
    expect(dead.everRan).toBe(true)
    expect(dead.stale).toBe(true)
  })

  it('treats an unreadable or malformed receipt as never-armed, not as healthy', () => {
    // Failing closed matters more here than anywhere else: reporting a broken
    // daemon as healthy is the exact vacuous pass this receipt exists to stop.
    const root = makeRepo()
    mkdirSync(join(root, '.work-guard'), { recursive: true })
    writeFileSync(join(root, '.work-guard', 'tick.json'), 'not json{')
    expect(timerHealth(root, NOW).everRan).toBe(false)
    writeFileSync(join(root, '.work-guard', 'tick.json'), '{"lastTickMs":"soon"}')
    expect(timerHealth(root, NOW).everRan).toBe(false)
  })

  it('keeps pre-upgrade receipts healthy while reporting runtime evidence as unknown', () => {
    const root = makeRepo()
    mkdirSync(join(root, '.work-guard'), { recursive: true })
    writeFileSync(
      join(root, '.work-guard', 'tick.json'),
      `${JSON.stringify({ lastTickMs: NOW - 60_000 })}\n`
    )
    expect(timerHealth(root, NOW)).toMatchObject({
      everRan: true,
      stale: false,
      node: null,
      parseOk: null
    })
  })

  it('runs self-check outside a Git repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'work-guard-self-check-'))
    repos.push(outside)
    const output = execFileSync(
      process.execPath,
      [join(process.cwd(), 'scripts', 'work-guard.cjs'), 'self-check'],
      { cwd: outside, encoding: 'utf8' }
    )
    expect(output).toContain(`self-check ok under ${process.version}`)
  })
})

describe('versioned marker observations', () => {
  it('keeps the legacy heartbeat entry while retaining a vanished marker tombstone', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'claimed.ts'), 'export const claimed = 1\n')
    const file = writeMarker(root, 'observed', {
      pid: process.pid,
      expires: iso(NOW + 60_000),
      paths: ['src/claimed.ts']
    })
    const parsed = markerFor(root, file)
    const current = advanceHeartbeats(root, [parsed], dirtyEntries(root), NOW)

    expect(current).toMatchObject({
      schemaVersion: 2,
      [file]: { session: 'test-observed', claimedDirty: 1 },
      markers: {
        [file]: {
          present: true,
          marker: { session: 'test-observed' }
        }
      }
    })
    const observationId = current.markers[file].observationId
    const vanished = advanceHeartbeats(root, [], dirtyEntries(root), NOW + 1_000)
    expect(vanished.markers).toEqual({})
    expect(vanished.tombstones[observationId]).toMatchObject({
      present: false,
      marker: { session: 'test-observed' }
    })
  })
})

describe('launchd interpreter path', () => {
  it('prefers a stable symlink over a versioned one that resolves to it', () => {
    // process.execPath under Homebrew is /opt/homebrew/Cellar/node/<ver>/bin/node.
    // `brew upgrade node` deletes that directory and launchd can no longer
    // spawn the job — silently, because a healthy tick prints nothing.
    const cellar = '/opt/homebrew/Cellar/node/25.9.0_3/bin/node'
    const real = '/opt/homebrew/Cellar/node/25.9.0_3/bin/node'
    const probe = (p: string): string | null =>
      p === cellar || p === '/opt/homebrew/bin/node' ? real : null
    // @portability-ok — launchd is macOS-only, and this function's candidate list
    // is a pair of literal POSIX Homebrew paths declared in work-guard.cjs itself.
    // Building the expectation with path.join would assert nothing about the
    // behaviour under test, which is precisely "recognise THESE absolute paths".
    expect(stableNodePath(cellar, probe)).toBe('/opt/homebrew/bin/node')
  })

  it('keeps execPath when no stable candidate resolves to the same binary', () => {
    const exec = '/some/custom/node'
    const probe = (p: string): string | null => (p === exec ? '/some/custom/node' : null)
    expect(stableNodePath(exec, probe)).toBe(exec)
  })

  it('never swaps in a symlink pointing at a DIFFERENT node', () => {
    // A machine with two node installs must not have its daemon silently
    // repointed at the wrong runtime.
    const exec = '/opt/homebrew/Cellar/node/25.9.0_3/bin/node'
    const probe = (p: string): string | null =>
      p === exec ? '/real/a' : p === '/opt/homebrew/bin/node' ? '/real/b' : null
    expect(stableNodePath(exec, probe)).toBe(exec)
  })
})

describe('snapshots', () => {
  const indexHash = (root: string): string =>
    createHash('sha256')
      .update(readFileSync(join(root, '.git', 'index')))
      .digest('hex')

  it('captures tracked edits, another session’s staged work, and untracked files', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'seed.ts'), 'export const seed = 2\n')
    writeFileSync(join(root, 'src', 'staged.ts'), 'export const staged = 1\n')
    execFileSync('git', ['add', 'src/staged.ts'], { cwd: root, stdio: 'ignore' })
    writeFileSync(join(root, 'src', 'untracked.ts'), 'export const untracked = 1\n')

    const snap = takeSnapshot(root, 'test snapshot')
    expect(snap.ok).toBe(true)
    const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', snap.ref as string], {
      cwd: root,
      encoding: 'utf8'
    })
    expect(listed).toContain('src/staged.ts')
    expect(listed).toContain('src/untracked.ts')
    const captured = execFileSync('git', ['show', `${snap.ref}:src/seed.ts`], {
      cwd: root,
      encoding: 'utf8'
    })
    expect(captured).toContain('seed = 2')
  })

  it('leaves the real index, the working tree and HEAD untouched', () => {
    // The entire safety case for running this on a timer against a shared
    // checkout. `git stash create` was rejected for missing untracked files;
    // whatever replaced it must still not touch shared state.
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'seed.ts'), 'export const seed = 3\n')
    writeFileSync(join(root, 'src', 'other.ts'), 'export const other = 1\n')
    execFileSync('git', ['add', 'src/other.ts'], { cwd: root, stdio: 'ignore' })

    const before = {
      index: indexHash(root),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
    }
    takeSnapshot(root, 'non-mutation check')
    expect(indexHash(root)).toBe(before.index)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe(
      before.status
    )
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).toBe(
      before.head
    )
  })

  it('creates no branch and leaves the snapshot off the commit graph', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'seed.ts'), 'export const seed = 4\n')
    takeSnapshot(root, 'invisibility check')
    const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], {
      cwd: root,
      encoding: 'utf8'
    })
    expect(branches.split('\n').filter(Boolean)).toHaveLength(1)
    const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    })
    expect(count.trim()).toBe('1')
    expect(listSnapshots(root)).toHaveLength(1)
  })

  it('does not let two snapshots in the same second overwrite each other', () => {
    // The ref stamp is second-resolution. Before the sha suffix, a second
    // snapshot inside the same wall-clock second resolved to the same ref and
    // silently replaced the first — losing precisely the work the snapshot
    // exists to hold. Caught by the pruning test, so it gets its own name.
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'seed.ts'), 'export const seed = 100\n')
    const first = takeSnapshot(root, 'same-second A')
    writeFileSync(join(root, 'src', 'seed.ts'), 'export const seed = 200\n')
    const second = takeSnapshot(root, 'same-second B')

    expect(first.ok && second.ok).toBe(true)
    expect(second.ref).not.toBe(first.ref)
    expect(listSnapshots(root)).toHaveLength(2)
    // Both payloads are still retrievable, which is the property that matters.
    const readBack = (ref: string): string =>
      execFileSync('git', ['show', `${ref}:src/seed.ts`], { cwd: root, encoding: 'utf8' })
    expect(readBack(first.ref as string)).toContain('seed = 100')
    expect(readBack(second.ref as string)).toContain('seed = 200')
  })

  it('prunes only aged snapshots, and never the newest one', () => {
    // `update-ref -d` is the ONLY destructive thing this tool does, and it
    // deletes the safety net itself. A pruner that took the newest ref would
    // quietly undo the entire point on an idle machine.
    const root = makeRepo()
    const stamp = (daysAgo: number): string =>
      new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString()
    const previous = process.env.GIT_COMMITTER_DATE
    try {
      for (const [index, daysAgo] of [30, 20, 0].entries()) {
        process.env.GIT_COMMITTER_DATE = stamp(daysAgo)
        writeFileSync(join(root, 'src', 'seed.ts'), `export const seed = ${index + 10}\n`)
        expect(takeSnapshot(root, `aged ${daysAgo}d`).ok).toBe(true)
      }
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMITTER_DATE
      else process.env.GIT_COMMITTER_DATE = previous
    }
    expect(listSnapshots(root)).toHaveLength(3)

    pruneSnapshots(root, NOW)
    const survivors = listSnapshots(root)
    expect(survivors).toHaveLength(1)
    // The survivor is the newest, which is the one holding current work.
    expect(NOW - survivors[0].atMs).toBeLessThan(SNAPSHOT_KEEP_MS)
  })

  it('keeps the newest snapshot even when every snapshot is past the window', () => {
    const root = makeRepo()
    const previous = process.env.GIT_COMMITTER_DATE
    try {
      for (const [index, daysAgo] of [40, 35].entries()) {
        process.env.GIT_COMMITTER_DATE = new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString()
        writeFileSync(join(root, 'src', 'seed.ts'), `export const seed = ${index + 20}\n`)
        takeSnapshot(root, `ancient ${daysAgo}d`)
      }
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMITTER_DATE
      else process.env.GIT_COMMITTER_DATE = previous
    }
    pruneSnapshots(root, NOW)
    expect(listSnapshots(root)).toHaveLength(1)
  })

  it('does not re-snapshot an unchanged tree', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'seed.ts'), 'export const seed = 5\n')
    expect(takeSnapshot(root, 'first').skipped).toBeUndefined()
    expect(takeSnapshot(root, 'second').skipped).toBe(true)
    expect(listSnapshots(root)).toHaveLength(1)
  })
})

// TaskWraith's own runtime lock projector writes markers into the SAME namespace
// this guard reads, but in a different dialect: every YAML scalar is quoted
// (its helper is JSON.stringify), tree leases go to `trees:` and workspace
// leases to `workspaceWide: true`. Reading only unquoted scalars and `paths:`
// meant a LIVE runtime lock parsed as an expiry of NaN claiming nothing.
describe('runtime marker dialect', () => {
  function writeRuntimeMarker(root: string, body: string): string {
    const file = '.WORK-IN-PROGRESS-taskwraith-runtime-probe.md'
    writeFileSync(join(root, file), `---\n${body}---\nbody\n`)
    return file
  }

  it('parses a quoted expires instead of yielding NaN', () => {
    const root = makeRepo()
    const when = '2026-07-30T23:17:41.346Z'
    const file = writeRuntimeMarker(
      root,
      `session: "s"\nagent: "taskwraith-runtime"\npid: 1\nderived: true\nexpires: ${JSON.stringify(when)}\npaths:\n  - "src/app.ts"\n`
    )
    const marker = markerFor(root, file)
    expect(marker.expiresMs).toBe(Date.parse(when))
    expect(marker.expiresMs).not.toBeNaN()
  })

  it('decodes JSON-quoted task labels without retaining escape syntax', () => {
    const root = makeRepo()
    const task = 'Fix "quoted" workspace paths'
    const file = writeRuntimeMarker(
      root,
      `session: "s"\nagent: "taskwraith-runtime"\ntask: ${JSON.stringify(task)}\npid: 1\nderived: true\nexpires: "2099-01-01T00:00:00Z"\npaths:\n  - "src/app.ts"\n`
    )
    expect(markerFor(root, file).task).toBe(task)
  })

  it('claims tree leases, which never appear under paths:', () => {
    const root = makeRepo()
    const file = writeRuntimeMarker(
      root,
      `session: "s"\nagent: "taskwraith-runtime"\npid: 1\nderived: true\nexpires: "2099-01-01T00:00:00Z"\ntrees:\n  - "src"\n`
    )
    const marker = markerFor(root, file)
    expect(marker.matchers.some((match) => match('src/app.ts'))).toBe(true)
    expect(marker.matchers.some((match) => match('docs/readme.md'))).toBe(false)
  })

  it('treats a workspace-wide lease as claiming everything', () => {
    const root = makeRepo()
    const file = writeRuntimeMarker(
      root,
      `session: "s"\nagent: "taskwraith-runtime"\npid: 1\nderived: true\nworkspaceWide: true\nexpires: "2099-01-01T00:00:00Z"\n`
    )
    const marker = markerFor(root, file)
    expect(marker.matchers.some((match) => match('anywhere/at/all.ts'))).toBe(true)
  })
})
