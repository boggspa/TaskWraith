import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Marker = {
  file: string
  pid: number | null
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
  listSnapshots
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
  options: { pid: number | null; expires: string; paths: string[] }
): string {
  const file = `.WORK-IN-PROGRESS-${slug}.md`
  const pidLine = options.pid === null ? '' : `pid: ${options.pid}\n`
  writeFileSync(
    join(root, file),
    `---\nsession: test-${slug}\nagent: test agent\n${pidLine}expires: ${options.expires}\npaths:\n${options.paths
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
  })

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

  it('does not re-snapshot an unchanged tree', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'seed.ts'), 'export const seed = 5\n')
    expect(takeSnapshot(root, 'first').skipped).toBeUndefined()
    expect(takeSnapshot(root, 'second').skipped).toBe(true)
    expect(listSnapshots(root)).toHaveLength(1)
  })
})
