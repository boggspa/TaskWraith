import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { MessageChannel } from 'node:worker_threads'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_REGISTRY_ROOT_ENV,
  hostRegistryDefaultRoot
} from '../../src/host-runtime/HostRegistry'
import {
  observeProcessBirthIdentity,
  type ProcessBirthObservation
} from '../../src/host-runtime/ProcessBirthIdentity'
import {
  RegistryIsolationGuard,
  attributeRegistryWriter,
  readProcessParents,
  readRegistrySnapshot,
  realHostRegistryRoots,
  startHostRegistryIsolation,
  temporaryRoots,
  watchDrainDelayMs,
  watchRegistryDirectory,
  type ProcessParents,
  type RegistryGuardProcessPorts,
  type RegistryIsolationGuardOptions
} from './hostRegistryIsolation'

const temporary: string[] = []
/** Real children: killed in teardown only while they still have the birth recorded at spawn. */
const children: Array<{ readonly pid: number; readonly birthIdentity: string }> = []
afterEach(async () => {
  while (children.length) {
    const child = children.pop()!
    const now = await observeProcessBirthIdentity(child.pid)
    if (now.state === 'live' && now.birthIdentity === child.birthIdentity) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporary.push(path)
  return path
}

const RUN = 500
const RUN_START = Date.parse('2026-09-23T10:00:00.000Z')
const BEFORE_RUN = RUN_START - 3_600_000
const DURING_RUN = RUN_START + 60_000
const REAL_PROFILE = '/profiles/real'
/** A test Host's profile: under the OS temporary directory, never created. */
const TEMPORARY_PROFILE = join(tmpdir(), 'host-registry-isolation-orphan-profile')
const hostCommand = (profile: string): string =>
  `/usr/local/bin/node /Applications/TaskWraith.app/Contents/Resources/host/host-runtime/cli.js serve --mode production --profile ${profile}`

interface FakeProcess {
  readonly ppid: number
  readonly birth: string
  readonly startedAtMs: number
  readonly command: string
  alive: boolean
}

/**
 * 500 is this run, 600 and 700 run under it. 400 is a shell and 950 the app's
 * main process, both outside the run and older than it; 900 is the app's Host
 * and 910 a Host the app started mid-run. 920 is a Host started mid-run whose
 * parent is gone, serving a temporary profile: an orphaned test Host adopted
 * by init. 960 is the app relaunched mid-run and 940 its Host, and 930 a Host
 * whose `tw` exited before it published, adopted by init: both serve real
 * profiles, as does 935, an orphan whose profile only begins like /tmp.
 * 47878 is dead.
 */
function processTable(): Map<number, FakeProcess> {
  const born = (pid: number) => `${pid}`.padStart(64, 'b')
  const entry = (pid: number, ppid: number, startedAtMs: number, command: string) =>
    [pid, { ppid, birth: born(pid), startedAtMs, command, alive: true }] as const
  return new Map<number, FakeProcess>([
    entry(1, 0, BEFORE_RUN, '/sbin/launchd'),
    entry(400, 1, BEFORE_RUN, '/bin/zsh'),
    entry(RUN, 400, BEFORE_RUN, 'node vitest'),
    entry(600, RUN, DURING_RUN, 'node vitest worker'),
    entry(700, 600, DURING_RUN, hostCommand('/tmp/host-test-profile')),
    entry(950, 1, BEFORE_RUN, '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'),
    entry(900, 950, BEFORE_RUN, hostCommand(REAL_PROFILE)),
    entry(910, 950, DURING_RUN, hostCommand('/profiles/second')),
    entry(920, 1, DURING_RUN, hostCommand(TEMPORARY_PROFILE)),
    entry(960, 1, DURING_RUN, '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'),
    entry(940, 960, DURING_RUN, hostCommand('/profiles/relaunched')),
    entry(930, 1, DURING_RUN, hostCommand('/profiles/tui')),
    entry(935, 1, DURING_RUN, hostCommand('/tmp2/profile'))
  ])
}

function fakePorts(table: Map<number, FakeProcess>): RegistryGuardProcessPorts {
  const running = (pid: number) => {
    const found = table.get(pid)
    return found?.alive ? found : null
  }
  return {
    readParents: () =>
      new Map(
        [...table].filter(([, found]) => found.alive).map(([pid, found]) => [pid, found.ppid])
      ),
    observeBirth: (pid) => {
      const found = running(pid)
      return found
        ? { state: 'live', birthIdentity: found.birth, startedAtMs: found.startedAtMs }
        : { state: 'dead' }
    },
    observeCommand: (pid) => {
      const found = running(pid)
      return found ? { state: 'live', commandLine: found.command, argv: null } : { state: 'dead' }
    }
  }
}

/** The parent table the attribution tests walk: 700 -> 600 -> 500 (this run); 900 -> 1. */
const TABLE: ProcessParents = new Map([
  [500, 400],
  [600, 500],
  [700, 600],
  [900, 1],
  [400, 1]
])

function entry(
  root: string,
  id: string,
  pid: number,
  options: {
    readonly profile?: string
    readonly birth?: string | null
    readonly bootEpoch?: string | null
    readonly beatSeq?: number
  } = {}
): string {
  mkdirSync(root, { recursive: true })
  const path = join(root, `${id.repeat(16)}.json`)
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: 'taskwraith.host-registry.v1',
      pid,
      birthIdentity: options.birth === undefined ? `${pid}`.padStart(64, 'b') : options.birth,
      ...(options.bootEpoch === undefined ? {} : { bootEpoch: options.bootEpoch }),
      profilePath: options.profile ?? '/profiles/p',
      beatSeq: options.beatSeq ?? 0
    })}\n`
  )
  return path
}

describe('attributeRegistryWriter', () => {
  it('walks the table up to this run, and reads a dead or unnamed writer as unknown', () => {
    expect(attributeRegistryWriter(500, RUN, TABLE)).toBe('this-run')
    expect(attributeRegistryWriter(700, RUN, TABLE)).toBe('this-run')
    expect(attributeRegistryWriter(900, RUN, TABLE)).toBe('other')
    expect(attributeRegistryWriter(400, RUN, TABLE)).toBe('other')
    expect(attributeRegistryWriter(47878, RUN, TABLE)).toBe('unknown')
    expect(attributeRegistryWriter(null, RUN, TABLE)).toBe('unknown')
    expect(attributeRegistryWriter(700, RUN, null)).toBe('unknown')
    const cycle: ProcessParents = new Map([
      [10, 11],
      [11, 10]
    ])
    expect(attributeRegistryWriter(10, RUN, cycle)).toBe('other')
  })

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'attributes a real child of this process to the run and launchd/init to nobody',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
        stdio: 'ignore'
      })
      try {
        const pid = child.pid
        if (pid === undefined) throw new Error('spawn failed')
        const table = readProcessParents()
        expect(table?.get(pid)).toBe(process.pid)
        expect(attributeRegistryWriter(pid, process.pid, table)).toBe('this-run')
        expect(attributeRegistryWriter(1, process.pid, table)).toBe('other')
      } finally {
        child.kill('SIGKILL')
      }
    }
  )
})

describe('readRegistrySnapshot', () => {
  it('reads an absent root as null, reads only entry names, and hashes every file on every read', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    expect(readRegistrySnapshot(root)).toBeNull()
    const path = entry(root, 'a', 700, { bootEpoch: 'boot-1' })
    // No Host reads any other name: a publish temporary, a Finder file, and
    // near misses (upper case, one digit short, another extension).
    for (const other of [
      `.${'a'.repeat(16)}.json.700.uuid.tmp`,
      '.DS_Store',
      `${'B'.repeat(16)}.json`,
      `${'c'.repeat(15)}.json`,
      `${'d'.repeat(16)}.json.bak`
    ]) {
      writeFileSync(join(root, other), '{"pid":7')
    }
    const name = `${'a'.repeat(16)}.json`
    const first = readRegistrySnapshot(root)
    expect([...(first?.keys() ?? [])]).toEqual([name])
    expect(first?.get(name)?.record).toEqual({
      pid: 700,
      birthIdentity: '700'.padStart(64, 'b'),
      bootEpoch: 'boot-1',
      profilePath: '/profiles/p'
    })
    expect(first?.get(name)?.hash).toMatch(/^[0-9a-f]{64}$/)
    writeFileSync(path, '{"pid": 900, "profilePath": "/profiles/q"}\n')
    const second = readRegistrySnapshot(root)
    expect(second?.get(name)?.hash).not.toBe(first?.get(name)?.hash)
    expect(second?.get(name)?.record).toEqual({
      pid: 900,
      birthIdentity: null,
      bootEpoch: null,
      profilePath: '/profiles/q'
    })
  })
})

describe('temporaryRoots', () => {
  it('holds the OS temporary directory, /tmp and /var/tmp, as spelled and as resolved', () => {
    const roots = temporaryRoots()
    for (const candidate of [tmpdir(), '/tmp', '/var/tmp']) {
      expect(roots).toContain(resolve(candidate))
      if (existsSync(candidate)) expect(roots).toContain(realpathSync(candidate))
    }
  })
})

describe('RegistryIsolationGuard', () => {
  const guardFor = (
    root: string,
    table = processTable(),
    clock = { now: DURING_RUN },
    extra: Partial<RegistryIsolationGuardOptions> = {}
  ) =>
    new RegistryIsolationGuard({
      realRoot: root,
      ancestorPid: RUN,
      ports: fakePorts(table),
      runStartedAtMs: RUN_START,
      removalGraceMs: 10_000,
      now: () => clock.now,
      ...extra
    })

  it("leaves a real Host's own lifecycle alone: publish, refresh, removal as it exits, and an inert baseline entry", () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    entry(root, 'd', 47878)
    const table = processTable()
    const guard = guardFor(root, table)
    guard.poll()
    const real = entry(root, 'e', 900, { profile: REAL_PROFILE })
    guard.poll()
    entry(root, 'e', 900, { profile: REAL_PROFILE, beatSeq: 1 })
    guard.poll()
    // The Host removes its entry during cleanup and then exits.
    unlinkSync(real)
    guard.poll()
    expect(guard.pendingRemovals()).toBe(1)
    table.get(900)!.alive = false
    guard.poll()
    expect(guard.pendingRemovals()).toBe(0)
    // A Host the app starts during the run is anchored by the app.
    entry(root, 'f', 910, { profile: '/profiles/second' })
    guard.poll()
    expect(guard.violations()).toEqual([])
  })

  it('fails on an entry naming init, a non-Host, another birth, or a dead pid (T3)', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(root)
    const guard = guardFor(root)
    entry(root, '1', 1, { birth: 'c'.repeat(64) })
    entry(root, '4', 400, { profile: REAL_PROFILE })
    entry(root, '9', 900, { profile: REAL_PROFILE, birth: 'c'.repeat(64) })
    entry(root, '8', 900, { profile: '/profiles/another' })
    entry(root, '7', 47878)
    guard.poll()
    // In name order: init with another birth, a shell, a dead pid, the real
    // Host named for a profile it does not serve, and with another birth.
    expect(
      guard.violations().map(({ change, pid, attribution }) => [change, pid, attribution])
    ).toEqual([
      ['created', 1, 'unverified'],
      ['created', 400, 'unverified'],
      ['created', 47878, 'unknown'],
      ['created', 900, 'unverified'],
      ['created', 900, 'unverified']
    ])
  })

  it('fails on an entry this run published, even when its Host removed it again', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(root)
    const guard = guardFor(root)
    const ours = entry(root, 'a', 700, { profile: '/tmp/host-test-profile' })
    guard.poll()
    // A refresh, then the Host's own clean removal: one finding, not three.
    entry(root, 'a', 700, { profile: '/tmp/host-test-profile', beatSeq: 1 })
    guard.poll()
    unlinkSync(ours)
    guard.poll()
    expect(guard.violations()).toEqual([
      {
        name: `${'a'.repeat(16)}.json`,
        change: 'created',
        pid: 700,
        attribution: 'this-run',
        detail: 'pid 700, profile /tmp/host-test-profile: pid 700 runs under this test run'
      }
    ])
  })

  it('fails on a Host serving a temporary profile that started during the run with no ancestor outside it: an orphaned test Host (T5)', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(root)
    const guard = guardFor(root)
    entry(root, '2', 920, { profile: TEMPORARY_PROFILE })
    // The same profile spelled through another directory is judged resolved.
    entry(root, '5', 920, {
      profile: `${TEMPORARY_PROFILE}${sep}..${sep}host-registry-isolation-orphan-profile`
    })
    guard.poll()
    expect(guard.violations()).toEqual(
      ['2', '5'].map((id) =>
        expect.objectContaining({
          name: `${id.repeat(16)}.json`,
          change: 'created',
          pid: 920,
          attribution: 'unverified',
          detail: expect.stringContaining(
            'serves a temporary profile, started during this run and no ancestor outside it did'
          )
        })
      )
    )
  })

  it('accepts a Host with no ancestor outside the run when it serves a real profile: an app relaunched mid-run, a TUI whose tw exited (C2)', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(root)
    const table = processTable()
    const guard = guardFor(root, table)
    entry(root, '3', 940, { profile: '/profiles/relaunched' })
    const tui = entry(root, '4', 930, { profile: '/profiles/tui' })
    guard.poll()
    entry(root, '3', 940, { profile: '/profiles/relaunched', beatSeq: 1 })
    guard.poll()
    // The TUI's Host removes its entry as it exits.
    unlinkSync(tui)
    table.get(930)!.alive = false
    guard.poll()
    expect(guard.pendingRemovals()).toBe(0)
    expect(guard.violations()).toEqual([])

    // The same Hosts and entries, were those profiles temporary: test Hosts.
    const strictRoot = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(strictRoot)
    const strict = guardFor(strictRoot, processTable(), undefined, {
      temporaryRoots: ['/profiles']
    })
    entry(strictRoot, '3', 940, { profile: '/profiles/relaunched' })
    entry(strictRoot, '4', 930, { profile: '/profiles/tui' })
    strict.poll()
    expect(
      strict.violations().map(({ change, pid, attribution }) => [change, pid, attribution])
    ).toEqual([
      ['created', 940, 'unverified'],
      ['created', 930, 'unverified']
    ])
  })

  it('reads a profile as temporary only inside a temporary root, never beside one sharing its prefix (D3)', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(root)
    const guard = guardFor(root)
    // /tmp2 begins like /tmp but lies outside it: the orphan's profile is real.
    entry(root, '6', 935, { profile: '/tmp2/profile' })
    guard.poll()
    expect(guard.violations()).toEqual([])

    // The same orphan, with /tmp2 itself a temporary root, is a test Host.
    const strictRoot = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(strictRoot)
    const strict = guardFor(strictRoot, processTable(), undefined, { temporaryRoots: ['/tmp2'] })
    entry(strictRoot, '6', 935, { profile: '/tmp2/profile' })
    strict.poll()
    expect(
      strict.violations().map(({ change, pid, attribution }) => [change, pid, attribution])
    ).toEqual([['created', 935, 'unverified']])
  })

  it('never counts a name that is not an entry: a Finder .DS_Store or a stray file created, rewritten or removed (C3)', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(root)
    writeFileSync(join(root, '.DS_Store'), 'finder-1')
    writeFileSync(join(root, 'notes.txt'), 'x')
    const guard = guardFor(root)
    writeFileSync(join(root, '.DS_Store'), 'finder-2, longer')
    unlinkSync(join(root, 'notes.txt'))
    writeFileSync(join(root, `${'B'.repeat(16)}.json`), '{}')
    writeFileSync(join(root, `${'c'.repeat(16)}.json.bak`), '{}')
    // Watch events for them, and for a stray name already gone again.
    guard.note('.DS_Store')
    guard.note('notes.txt')
    guard.note(`${'d'.repeat(16)}.json.bak`)
    guard.poll()
    expect(guard.violations()).toEqual([])
    // The guard is live all the while: an entry naming a dead pid counts.
    entry(root, '7', 47878)
    guard.poll()
    expect(guard.violations().map(({ name, change }) => [name, change])).toEqual([
      [`${'7'.repeat(16)}.json`, 'created']
    ])
  })

  it('fails on a name a watch saw that no poll ever did: written and removed between two polls (T4)', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(root)
    const guard = guardFor(root)
    const seen = entry(root, 'e', 900, { profile: REAL_PROFILE })
    guard.poll()
    // The watch reports an entry that is gone by the poll, a late event for
    // one a poll already saw (removed since), a publish temporary and a
    // Finder file.
    guard.note(`${'3'.repeat(16)}.json`)
    guard.note(`${'e'.repeat(16)}.json`)
    guard.note(`.${'e'.repeat(16)}.json.900.uuid.tmp`)
    guard.note('.DS_Store')
    unlinkSync(seen)
    guard.poll()
    expect(guard.violations()).toEqual([
      expect.objectContaining({ name: `${'3'.repeat(16)}.json`, change: 'transient' })
    ])
  })

  it("fails on deleting a live outside Host's entry once its grace passes, or rewriting it to name another process (T6)", () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    const deleted = entry(root, 'e', 900, { profile: REAL_PROFILE })
    entry(root, 'f', 900, { profile: REAL_PROFILE })
    entry(root, 'b', 900, { profile: REAL_PROFILE })
    const clock = { now: DURING_RUN }
    const guard = guardFor(root, processTable(), clock)
    unlinkSync(deleted)
    guard.poll()
    // Inside the grace the Host may still be on its way out.
    expect(guard.violations()).toEqual([])
    expect(guard.pendingRemovals()).toBe(1)
    clock.now += 10_000
    guard.poll()
    expect(guard.pendingRemovals()).toBe(0)
    // Replaced by another live Host's record while the first is still
    // running; rewritten to name init.
    entry(root, 'b', 910, { profile: '/profiles/second' })
    entry(root, 'f', 1, { birth: 'c'.repeat(64) })
    guard.poll()
    expect(
      guard
        .violations()
        .map(({ name, change, pid, attribution }) => [name, change, pid, attribution])
    ).toEqual([
      [`${'e'.repeat(16)}.json`, 'removed', 900, 'outside-host'],
      [`${'b'.repeat(16)}.json`, 'rewritten', 910, 'outside-host'],
      [`${'f'.repeat(16)}.json`, 'rewritten', 1, 'unverified']
    ])
    expect(guard.violations()[0].detail).toContain('was deleted while that Host kept running')
  })

  it("fails on a rewrite that changes only the boot epoch of a live outside Host's entry: that Host reads it as foreign (C4)", () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    entry(root, 'e', 900, { profile: REAL_PROFILE, bootEpoch: 'boot-1' })
    const guard = guardFor(root)
    // The Hosts' own refreshes keep their boot epoch: a baseline entry, and
    // one published during the run.
    entry(root, 'e', 900, { profile: REAL_PROFILE, bootEpoch: 'boot-1', beatSeq: 1 })
    entry(root, 'f', 910, { profile: '/profiles/second', bootEpoch: 'boot-1' })
    guard.poll()
    entry(root, 'f', 910, { profile: '/profiles/second', bootEpoch: 'boot-1', beatSeq: 1 })
    guard.poll()
    expect(guard.violations()).toEqual([])
    // The same pid and birth under another boot epoch, or none.
    entry(root, 'e', 900, { profile: REAL_PROFILE, bootEpoch: 'boot-2', beatSeq: 2 })
    entry(root, 'f', 910, { profile: '/profiles/second', bootEpoch: null, beatSeq: 2 })
    guard.poll()
    expect(
      guard
        .violations()
        .map(({ name, change, pid, attribution }) => [name, change, pid, attribution])
    ).toEqual([
      [`${'e'.repeat(16)}.json`, 'rewritten', 900, 'outside-host'],
      [`${'f'.repeat(16)}.json`, 'rewritten', 910, 'outside-host']
    ])
    expect(guard.violations()[0].detail).toContain(
      'the entry of pid 900, still running, was rewritten with another boot epoch: that Host reads it as foreign and stops itself'
    )
  })

  it('judges a rewrite by its bytes when inode, size, mtime and mode are all unchanged (C6)', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    const name = `${'6'.repeat(16)}.json`
    const mtime = 1_700_000_000
    const path = entry(root, '6', 900, { profile: REAL_PROFILE })
    utimesSync(path, mtime, mtime)
    const guard = guardFor(root)
    const before = readRegistrySnapshot(root)!.get(name)!
    // The same file, the same length: another birth identity in place of 900's.
    entry(root, '6', 900, { profile: REAL_PROFILE, birth: 'c'.repeat(64) })
    utimesSync(path, mtime, mtime)
    const after = readRegistrySnapshot(root)!.get(name)!
    expect(after.stamp).toBe(before.stamp)
    expect(after.hash).not.toBe(before.hash)
    guard.poll()
    expect(
      guard
        .violations()
        .map(({ name: found, change, pid, attribution }) => [found, change, pid, attribution])
    ).toEqual([[name, 'rewritten', 900, 'unverified']])
  })

  it('lets a Host replace the entry of one that is gone', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    entry(root, 'b', 900, { profile: REAL_PROFILE })
    const table = processTable()
    const guard = guardFor(root, table)
    table.get(900)!.alive = false
    entry(root, 'b', 910, { profile: '/profiles/second' })
    guard.poll()
    expect(guard.violations()).toEqual([])
  })

  it('fails when a baseline entry is removed or rewritten by anything but a verified outside Host', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    const stale = entry(root, 'd', 47878)
    const other = entry(root, 'c', 47879)
    const guard = guardFor(root)
    unlinkSync(stale)
    // Moved aside under a name that is no entry, and its name rewritten.
    renameSync(other, `${other}.moved`)
    writeFileSync(other, 'not json\n')
    guard.poll()
    expect(
      guard.violations().map((violation) => [violation.change, violation.attribution])
    ).toEqual([
      ['rewritten', 'unknown'],
      ['removed', 'baseline-stale']
    ])
  })

  it('fails when the run creates the real root, unless a real Host did', () => {
    const parent = scratch('host-registry-isolation-')
    const created = join(parent, 'hosts')
    const guard = guardFor(created)
    mkdirSync(created)
    guard.poll()
    expect(guard.violations().map((violation) => violation.change)).toEqual(['root-created'])

    const byRealHost = join(parent, 'other-hosts')
    const exempt = guardFor(byRealHost)
    entry(byRealHost, 'e', 900, { profile: REAL_PROFILE })
    exempt.poll()
    expect(exempt.violations()).toEqual([])
  })
})

describe('startHostRegistryIsolation', () => {
  it('points the inherited environment at a fresh per-run root and removes it at teardown', async () => {
    const env: NodeJS.ProcessEnv = {}
    const realRoot = join(scratch('host-registry-isolation-real-'), 'hosts')
    const reports: string[] = []
    let failed = 0
    const teardown = startHostRegistryIsolation({
      env,
      realRoots: [realRoot],
      temporaryDirectory: scratch('host-registry-isolation-tmp-'),
      ports: fakePorts(processTable()),
      ancestorPid: RUN,
      runStartedAtMs: RUN_START,
      watch: null,
      report: (text) => reports.push(text),
      fail: () => {
        failed += 1
      }
    })
    const runRoot = env[HOST_REGISTRY_ROOT_ENV]
    expect(runRoot).toBeDefined()
    expect(existsSync(runRoot!)).toBe(true)
    // A Host publishing into the per-run root is exactly what should happen.
    entry(runRoot!, 'a', 700)
    await teardown()
    expect(existsSync(runRoot!)).toBe(false)
    expect(reports).toEqual([])
    expect(failed).toBe(0)
  })

  it('reports and fails the run when this run wrote into any real root', async () => {
    const env: NodeJS.ProcessEnv = {}
    const homeRoot = join(scratch('host-registry-isolation-real-'), 'hosts')
    const passwdRoot = join(scratch('host-registry-isolation-passwd-'), 'hosts')
    const reports: string[] = []
    let failed = 0
    const teardown = startHostRegistryIsolation({
      env,
      realRoots: [homeRoot, passwdRoot],
      temporaryDirectory: scratch('host-registry-isolation-tmp-'),
      ports: fakePorts(processTable()),
      ancestorPid: RUN,
      runStartedAtMs: RUN_START,
      watch: null,
      report: (text) => reports.push(text),
      fail: () => {
        failed += 1
      }
    })
    // A child spawned without HOME resolves the password database's home.
    entry(passwdRoot, 'b', 600)
    await teardown()
    expect(failed).toBe(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain(
      `FAILED: this test run changed the real Host registry ${passwdRoot}.`
    )
    expect(reports[0]).not.toContain(homeRoot)
    expect(reports[0]).toContain(`created ${'b'.repeat(16)}.json (this-run): pid 600`)
    expect(reports[0]).toContain(HOST_REGISTRY_ROOT_ENV)
  })

  it('waits out the grace of a removal at teardown before giving its verdict', async () => {
    for (const hostExits of [true, false]) {
      const realRoot = join(scratch('host-registry-isolation-real-'), 'hosts')
      const table = processTable()
      entry(realRoot, 'e', 900, { profile: REAL_PROFILE })
      const reports: string[] = []
      let failed = 0
      const teardown = startHostRegistryIsolation({
        env: {},
        realRoots: [realRoot],
        temporaryDirectory: scratch('host-registry-isolation-tmp-'),
        ports: fakePorts(table),
        ancestorPid: RUN,
        runStartedAtMs: RUN_START,
        pollIntervalMs: 20,
        removalGraceMs: 300,
        watch: null,
        report: (text) => reports.push(text),
        fail: () => {
          failed += 1
        }
      })
      // The entry goes just before the run ends: the Host's own cleanup when
      // it then exits, a deletion under a live Host when it does not.
      rmSync(join(realRoot, `${'e'.repeat(16)}.json`))
      if (hostExits) {
        setTimeout(() => {
          table.get(900)!.alive = false
        }, 100)
      }
      await teardown()
      if (hostExits) {
        expect(reports).toEqual([])
        expect(failed).toBe(0)
      } else {
        expect(failed).toBe(1)
        expect(reports[0]).toContain(`removed ${'e'.repeat(16)}.json (outside-host)`)
      }
    }
  })

  /** A guard over scratch "real" roots, watched through fs.watch, with every event recorded. */
  function watchedIsolation(...realRoots: string[]) {
    const events: Array<string | null> = []
    const reports: string[] = []
    const verdict = { failed: 0 }
    const teardown = startHostRegistryIsolation({
      env: {},
      realRoots,
      temporaryDirectory: scratch('host-registry-isolation-tmp-'),
      // No interval poll lands inside these tests: only the watch can see it.
      pollIntervalMs: 60_000,
      watch: (path, onChange) =>
        watchRegistryDirectory(path, (name) => {
          events.push(name)
          onChange(name)
        }),
      report: (text) => reports.push(text),
      fail: () => {
        verdict.failed += 1
      }
    })
    return { events, reports, verdict, teardown }
  }

  it.skipIf(process.platform === 'win32')(
    'catches an entry written and removed between two polls through the directory watch (T4)',
    async () => {
      const realRoot = join(scratch('host-registry-isolation-real-'), 'hosts')
      mkdirSync(realRoot)
      const { events, reports, verdict, teardown } = watchedIsolation(realRoot)
      // A directory watch starts asynchronously (FSEvents on darwin), and a
      // change made before it is live is never reported: write and remove the
      // entry until the watch reports it. The guard's own watch is armed at
      // the start of a run, long before any test writes.
      await vi.waitFor(
        () => {
          unlinkSync(entry(realRoot, '9', process.pid))
          expect(events.length).toBeGreaterThan(0)
        },
        { timeout: 15_000, interval: 250 }
      )
      await teardown()
      expect(verdict.failed).toBe(1)
      expect(reports[0]).toContain(`${'9'.repeat(16)}.json`)
    },
    30_000
  )

  it.skipIf(process.platform === 'win32')(
    "catches an entry written and removed as the run's last act: teardown drains the watch before its verdict (C5)",
    async () => {
      const realRoot = join(scratch('host-registry-isolation-real-'), 'hosts')
      mkdirSync(realRoot)
      // Roots idle for long on either side: teardown waits for the busiest.
      const idle = [1, 2].map((index) => {
        const root = join(scratch(`host-registry-isolation-idle-${index}-`), 'hosts')
        mkdirSync(root)
        utimesSync(root, 1_700_000_000, 1_700_000_000)
        return root
      })
      const { events, reports, verdict, teardown } = watchedIsolation(idle[0], realRoot, idle[1])
      // Wait until the watch is live, through a name that is no entry.
      await vi.waitFor(
        () => {
          writeFileSync(join(realRoot, '.DS_Store'), String(Date.now()))
          expect(events).toContain('.DS_Store')
        },
        { timeout: 15_000, interval: 250 }
      )
      // The run's last act: teardown starts with no poll and no turn of the
      // event loop in between, so only a drained watch event can report it.
      unlinkSync(entry(realRoot, '5', process.pid))
      await teardown()
      expect(verdict.failed).toBe(1)
      expect(reports[0]).toContain(`transient ${'5'.repeat(16)}.json (unknown)`)
      expect(reports[0]).not.toContain('.DS_Store')
    },
    30_000
  )

  it('waits at teardown until a change the watch reports late has arrived, whichever root changed (D4)', async () => {
    // A busy root between two idle ones, and a watch that reports each change
    // 100 ms late: teardown waits until the busy root's change is 250 ms old.
    const roots = ['idle-1', 'busy', 'idle-2'].map((name) => {
      const root = join(scratch(`host-registry-isolation-${name}-`), 'hosts')
      mkdirSync(root)
      if (name !== 'busy') utimesSync(root, 1_700_000_000, 1_700_000_000)
      return root
    })
    const deliver = new Map<string, (name: string | null) => void>()
    const reports: string[] = []
    let failed = 0
    const teardown = startHostRegistryIsolation({
      env: {},
      realRoots: roots,
      temporaryDirectory: scratch('host-registry-isolation-tmp-'),
      pollIntervalMs: 60_000,
      teardownSettleMs: 250,
      watch: (path, onChange) => {
        deliver.set(path, onChange)
        return { close: () => undefined }
      },
      report: (text) => reports.push(text),
      fail: () => {
        failed += 1
      }
    })
    const name = `${'4'.repeat(16)}.json`
    unlinkSync(entry(roots[1], '4', process.pid))
    setTimeout(() => deliver.get(roots[1])?.(name), 100)
    await teardown()
    expect(failed).toBe(1)
    expect(reports[0]).toContain(`transient ${name} (unknown)`)
  })

  it('still delivers a watch event that fell due with the settle timer before the last poll (C5)', async () => {
    const realRoot = join(scratch('host-registry-isolation-real-'), 'hosts')
    mkdirSync(realRoot)
    // A watch whose events reach the loop the way FSEvents' do: signalled
    // from outside JavaScript and delivered in the I/O phase (a MessagePort).
    const channel = new MessageChannel()
    let deliver: ((name: string | null) => void) | null = null
    channel.port2.on('message', (name: string) => deliver?.(name))
    const reports: string[] = []
    let failed = 0
    const teardown = startHostRegistryIsolation({
      env: {},
      realRoots: [realRoot],
      temporaryDirectory: scratch('host-registry-isolation-tmp-'),
      pollIntervalMs: 60_000,
      teardownSettleMs: 20,
      watch: (_path, onChange) => {
        deliver = onChange
        return { close: () => undefined }
      },
      report: (text) => reports.push(text),
      fail: () => {
        failed += 1
      }
    })
    const name = `${'5'.repeat(16)}.json`
    try {
      // From the check phase: the entry comes and goes, teardown starts, its
      // event is posted, and the loop is held past the settle. The settle
      // timer and the event then fall due together, and timers run first.
      await new Promise<void>((settled, reject) => {
        setImmediate(() => {
          unlinkSync(entry(realRoot, '5', process.pid))
          const verdict = teardown()
          channel.port1.postMessage(name)
          const heldUntil = Date.now() + 100
          while (Date.now() < heldUntil) {
            // Hold the loop.
          }
          verdict.then(settled, reject)
        })
      })
    } finally {
      channel.port1.close()
    }
    expect(failed).toBe(1)
    expect(reports[0]).toContain(`transient ${name} (unknown)`)
  })

  it("waits at teardown only until the root's latest change is the settle old (D4)", () => {
    const now = 1_790_000_000_600
    // A root it cannot read, or nothing recent: no wait at all.
    expect(watchDrainDelayMs(Number.NEGATIVE_INFINITY, 250, now)).toBe(0)
    expect(watchDrainDelayMs(now - 10_000.5, 250, now)).toBe(0)
    expect(watchDrainDelayMs(now - 250.5, 250, now)).toBe(0)
    // A recent change: what is left of the settle.
    expect(watchDrainDelayMs(now - 100.5, 250, now)).toBe(149.5)
    expect(watchDrainDelayMs(now - 0.5, 250, now)).toBe(249.5)
    // Whole seconds only: the change may be up to a second later than stamped.
    expect(watchDrainDelayMs(1_790_000_000_000, 250, now)).toBe(650)
    expect(watchDrainDelayMs(1_790_000_000_000, 250, now + 1_000)).toBe(0)
    // Stamped in the future (a clock step): the whole window.
    expect(watchDrainDelayMs(now + 5_000.5, 250, now)).toBe(250)
    expect(watchDrainDelayMs(1_790_000_005_000, 250, now)).toBe(1_250)
  })

  it('costs a run no wait at teardown when no root has changed within the settle (D4)', async () => {
    const realRoot = join(scratch('host-registry-isolation-real-'), 'hosts')
    mkdirSync(realRoot)
    // The root last changed long ago, as a real registry mostly has; the
    // second does not exist.
    utimesSync(realRoot, 1_700_000_000, 1_700_000_000)
    const absentRoot = join(scratch('host-registry-isolation-absent-'), 'hosts')
    const reports: string[] = []
    let failed = 0
    const teardown = startHostRegistryIsolation({
      env: {},
      realRoots: [realRoot, absentRoot],
      temporaryDirectory: scratch('host-registry-isolation-tmp-'),
      pollIntervalMs: 60_000,
      // A settle this long would outlast the test: only no wait lets it pass.
      teardownSettleMs: 600_000,
      watch: () => ({ close: () => undefined }),
      report: (text) => reports.push(text),
      fail: () => {
        failed += 1
      }
    })
    await teardown()
    expect(reports).toEqual([])
    expect(failed).toBe(0)
  }, 10_000)

  it('watches ~/.taskwraith/hosts under HOME and the password database home, never the override', () => {
    const home = scratch('host-registry-isolation-home-')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv(HOST_REGISTRY_ROOT_ENV, join(home, 'run-root'))
    try {
      expect(homedir()).toBe(home)
      const roots = realHostRegistryRoots()
      expect(roots).toContain(hostRegistryDefaultRoot(home))
      expect(roots).toContain(hostRegistryDefaultRoot(userInfo().homedir))
      expect(roots).not.toContain(join(home, 'run-root'))
      expect(new Set(roots).size).toBe(roots.length)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

/**
 * The guard against real processes: stand-in Hosts are children of this
 * worker (or orphans it started), each serving a temporary profile unless a
 * test says otherwise; the guard's "run" is a pid that is none of their
 * ancestors, so they read as Hosts outside it. Every child is killed in
 * teardown, by pid and birth.
 */
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'RegistryIsolationGuard against real processes',
  () => {
    const STAND_IN = 'setInterval(() => {}, 1000)\n'

    async function birthOf(
      pid: number
    ): Promise<Extract<ProcessBirthObservation, { state: 'live' }>> {
      const birth = await observeProcessBirthIdentity(pid)
      if (birth.state !== 'live') throw new Error(`pid ${pid} is ${birth.state}`)
      return birth
    }

    function standInCli(base: string): string {
      const cli = join(base, 'payload', 'host-runtime', 'cli.js')
      mkdirSync(dirname(cli), { recursive: true })
      writeFileSync(cli, STAND_IN)
      return cli
    }

    async function startStandInHost(base: string, profile: string) {
      const child = spawn(
        process.execPath,
        [standInCli(base), 'serve', '--mode', 'production', '--profile', profile],
        { stdio: 'ignore' }
      )
      if (!child.pid) throw new Error('spawn failed')
      await new Promise((resolve) => setTimeout(resolve, 150))
      const birth = await birthOf(child.pid)
      children.push({ pid: child.pid, birthIdentity: birth.birthIdentity })
      return {
        pid: child.pid,
        birth,
        exited: new Promise((resolve) => child.once('exit', resolve))
      }
    }

    /**
     * A stand-in started in the background by a shell that then exits:
     * launchd adopts it, so no process of this run is its ancestor any more.
     */
    async function startOrphanedStandInHost(base: string, profile: string) {
      const cli = standInCli(base)
      const shell = spawn(
        '/bin/sh',
        [
          '-c',
          `"${process.execPath}" "${cli}" serve --mode production --profile "${profile}" >/dev/null 2>&1 & echo $!`
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
      let output = ''
      shell.stdout!.on('data', (chunk) => (output += String(chunk)))
      await new Promise((resolve) => shell.once('close', resolve))
      const pid = Number(output.trim())
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 150))
      const birth = await birthOf(pid)
      children.push({ pid, birthIdentity: birth.birthIdentity })
      expect(readProcessParents()?.get(pid)).toBe(1)
      return { pid, birth }
    }

    /** A pid that is nobody's ancestor: a child that has already exited. */
    async function outsideRunPid(): Promise<number> {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      await new Promise((resolve) => child.once('exit', resolve))
      return child.pid!
    }

    function publish(
      root: string,
      pid: number,
      birthIdentity: string,
      profile: string,
      {
        beatSeq = 0,
        bootEpoch = null
      }: { readonly beatSeq?: number; readonly bootEpoch?: string | null } = {}
    ): string {
      mkdirSync(root, { recursive: true })
      const path = join(root, 'a'.repeat(16) + '.json')
      writeFileSync(
        path,
        `${JSON.stringify({ schema: 'taskwraith.host-registry.v1', pid, birthIdentity, bootEpoch, profilePath: profile, beatSeq })}\n`
      )
      return path
    }

    it("leaves a verified outside Host's lifecycle alone, and fails on deleting its live entry or renaming it to init (T3, T6)", async () => {
      const base = scratch('host-registry-isolation-sub-')
      const root = join(base, 'hosts')
      const profile = scratch('host-registry-isolation-profile-')
      const host = await startStandInHost(base, profile)
      const guardOptions = {
        realRoot: root,
        ancestorPid: await outsideRunPid(),
        // Every process alive now predates this run.
        runStartedAtMs: Date.now() + 60_000,
        removalGraceMs: 300
      }

      // Lifecycle: publish, refresh, the Host exits and its entry goes.
      const lifecycle = new RegistryIsolationGuard(guardOptions)
      const path = publish(root, host.pid, host.birth.birthIdentity, profile)
      lifecycle.poll()
      publish(root, host.pid, host.birth.birthIdentity, profile, { beatSeq: 1 })
      lifecycle.poll()
      process.kill(host.pid, 'SIGKILL')
      await host.exited
      unlinkSync(path)
      lifecycle.poll()
      expect(lifecycle.pendingRemovals()).toBe(0)
      expect(lifecycle.violations()).toEqual([])

      // T6: a live outside Host's entry deleted, and one rewritten to name init.
      const live = await startStandInHost(base, profile)
      const deletedEntry = publish(root, live.pid, live.birth.birthIdentity, profile)
      const guard = new RegistryIsolationGuard(guardOptions)
      unlinkSync(deletedEntry)
      guard.poll()
      await new Promise((resolve) => setTimeout(resolve, 400))
      guard.poll()
      publish(root, 1, 'c'.repeat(64), profile)
      guard.poll()
      expect(
        guard.violations().map(({ change, pid, attribution }) => [change, pid, attribution])
      ).toEqual([
        ['removed', live.pid, 'outside-host'],
        ['created', 1, expect.stringMatching(/^(unverified|unknown)$/)]
      ])
      expect(await birthOf(live.pid)).toMatchObject({ birthIdentity: live.birth.birthIdentity })
    }, 30_000)

    it("fails on a rewrite of a live outside Host's entry that changes only its boot epoch (C4)", async () => {
      const base = scratch('host-registry-isolation-sub-')
      const root = join(base, 'hosts')
      const profile = scratch('host-registry-isolation-profile-')
      const host = await startStandInHost(base, profile)
      const own = { bootEpoch: 'boot-1' }
      publish(root, host.pid, host.birth.birthIdentity, profile, own)
      const guard = new RegistryIsolationGuard({
        realRoot: root,
        ancestorPid: await outsideRunPid(),
        runStartedAtMs: Date.now() + 60_000
      })
      publish(root, host.pid, host.birth.birthIdentity, profile, { ...own, beatSeq: 1 })
      guard.poll()
      expect(guard.violations()).toEqual([])
      publish(root, host.pid, host.birth.birthIdentity, profile, {
        bootEpoch: 'boot-2',
        beatSeq: 2
      })
      guard.poll()
      expect(guard.violations()).toEqual([
        expect.objectContaining({
          change: 'rewritten',
          pid: host.pid,
          attribution: 'outside-host',
          detail: expect.stringContaining('was rewritten with another boot epoch')
        })
      ])
      expect(await birthOf(host.pid)).toMatchObject({ birthIdentity: host.birth.birthIdentity })
    }, 30_000)

    // darwin only: every orphan goes to launchd there, while linux may hand
    // it to a subreaper older than the run (the guard's documented limit).
    it.skipIf(process.platform !== 'darwin')(
      'fails on an orphaned Host serving a temporary profile, started during the run, however genuine its entry (T5)',
      async () => {
        const base = scratch('host-registry-isolation-orphan-')
        const root = join(base, 'hosts')
        const profile = scratch('host-registry-isolation-profile-')
        const { pid, birth } = await startOrphanedStandInHost(base, profile)
        mkdirSync(root)
        const guard = new RegistryIsolationGuard({
          realRoot: root,
          ancestorPid: process.pid,
          runStartedAtMs: (birth.startedAtMs ?? Date.now()) - 1_000
        })
        publish(root, pid, birth.birthIdentity, profile)
        guard.poll()
        expect(guard.violations()).toEqual([
          expect.objectContaining({
            change: 'created',
            pid,
            attribution: 'unverified',
            detail: expect.stringContaining(
              'serves a temporary profile, started during this run and no ancestor outside it did'
            )
          })
        ])
      },
      30_000
    )

    it.skipIf(process.platform !== 'darwin')(
      'accepts an orphaned Host started during the run when it serves a real profile: an app relaunched mid-run (C2)',
      async () => {
        const base = scratch('host-registry-isolation-orphan-')
        const root = join(base, 'hosts')
        // A real profile's spelling, space and all; nothing is ever created there.
        const profile = join(
          userInfo().homedir,
          'Library',
          'Application Support',
          `taskwraith-registry-guard-test-${process.pid}-${Date.now()}`
        )
        expect(existsSync(profile)).toBe(false)
        expect(
          temporaryRoots().some((temporaryRoot) => profile.startsWith(`${temporaryRoot}/`))
        ).toBe(false)
        const { pid, birth } = await startOrphanedStandInHost(base, profile)
        mkdirSync(root)
        const guard = new RegistryIsolationGuard({
          realRoot: root,
          ancestorPid: process.pid,
          runStartedAtMs: (birth.startedAtMs ?? Date.now()) - 1_000
        })
        publish(root, pid, birth.birthIdentity, profile)
        guard.poll()
        publish(root, pid, birth.birthIdentity, profile, { beatSeq: 1 })
        guard.poll()
        expect(guard.violations()).toEqual([])
        expect(existsSync(profile)).toBe(false)
      },
      30_000
    )
  }
)
