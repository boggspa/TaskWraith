import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_REGISTRY_ROOT_ENV,
  hostRegistryDefaultRoot
} from '../../src/host-runtime/HostRegistry'
import {
  RegistryIsolationGuard,
  attributeRegistryWriter,
  readProcessParents,
  readRegistrySnapshot,
  realHostRegistryRoots,
  startHostRegistryIsolation,
  type ProcessParents
} from './hostRegistryIsolation'

const temporary: string[] = []
afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporary.push(path)
  return path
}

const RUN = 500
/** 700 -> 600 -> 500 (this run); 900 -> 1 (a real Host); 47878 is dead. */
const TABLE: ProcessParents = new Map([
  [500, 400],
  [600, 500],
  [700, 600],
  [900, 1],
  [400, 1]
])

function entry(root: string, id: string, pid: number, profile = '/profiles/p'): string {
  mkdirSync(root, { recursive: true })
  const path = join(root, `${id.repeat(16)}.json`)
  writeFileSync(
    path,
    `${JSON.stringify({ schema: 'taskwraith.host-registry.v1', pid, profilePath: profile })}\n`
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
  it('reads an absent root as null, skips publish temporaries, and re-reads only changed files', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    expect(readRegistrySnapshot(root)).toBeNull()
    const path = entry(root, 'a', 700)
    writeFileSync(join(root, `.${'a'.repeat(16)}.json.700.uuid.tmp`), '{"pid":7')
    const first = readRegistrySnapshot(root)
    expect([...(first?.keys() ?? [])]).toEqual([`${'a'.repeat(16)}.json`])
    expect(first?.get(`${'a'.repeat(16)}.json`)?.pid).toBe(700)
    const second = readRegistrySnapshot(root, first)
    expect(second?.get(`${'a'.repeat(16)}.json`)).toBe(first?.get(`${'a'.repeat(16)}.json`))
    writeFileSync(path, '{"pid": 900, "profilePath": "/profiles/q"}\n')
    const third = readRegistrySnapshot(root, second)
    expect(third?.get(`${'a'.repeat(16)}.json`)?.pid).toBe(900)
  })
})

describe('RegistryIsolationGuard', () => {
  const guardFor = (root: string): RegistryIsolationGuard =>
    new RegistryIsolationGuard({ realRoot: root, ancestorPid: RUN, readParents: () => TABLE })

  it('leaves a stale baseline entry and a real Host publishing and stopping alone', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    entry(root, 'd', 47878)
    const guard = guardFor(root)
    guard.poll()
    const real = entry(root, 'e', 900)
    guard.poll()
    writeFileSync(real, `${JSON.stringify({ pid: 900, beatSeq: 1 })}\n`)
    guard.poll()
    unlinkSync(real)
    guard.poll()
    expect(guard.violations()).toEqual([])
  })

  it('fails on an entry this run published, even when its Host removed it again', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    mkdirSync(root)
    const guard = guardFor(root)
    const ours = entry(root, 'a', 700, '/tmp/host-test-profile')
    guard.poll()
    // A refresh, then the Host's own clean removal: one finding, not three.
    writeFileSync(ours, `${JSON.stringify({ pid: 700, beatSeq: 1 })}\n`)
    guard.poll()
    unlinkSync(ours)
    guard.poll()
    expect(guard.violations()).toEqual([
      {
        name: `${'a'.repeat(16)}.json`,
        change: 'created',
        pid: 700,
        attribution: 'this-run',
        detail: 'pid 700, profile /tmp/host-test-profile'
      }
    ])
  })

  it('fails when a baseline entry is removed or rewritten by anything but a live outside process', () => {
    const root = join(scratch('host-registry-isolation-'), 'hosts')
    const stale = entry(root, 'd', 47878)
    const other = entry(root, 'c', 47879)
    const guard = guardFor(root)
    unlinkSync(stale)
    renameSync(other, `${other}.moved`)
    writeFileSync(other, 'not json\n')
    guard.poll()
    expect(
      guard.violations().map((violation) => [violation.change, violation.attribution])
    ).toEqual([
      ['rewritten', 'unknown'],
      ['created', 'unknown'],
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
    entry(byRealHost, 'e', 900)
    exempt.poll()
    expect(exempt.violations()).toEqual([])
  })
})

describe('startHostRegistryIsolation', () => {
  it('points the inherited environment at a fresh per-run root and removes it at teardown', () => {
    const env: NodeJS.ProcessEnv = {}
    const realRoot = join(scratch('host-registry-isolation-real-'), 'hosts')
    const reports: string[] = []
    let failed = 0
    const teardown = startHostRegistryIsolation({
      env,
      realRoots: [realRoot],
      temporaryDirectory: scratch('host-registry-isolation-tmp-'),
      readParents: () => TABLE,
      ancestorPid: RUN,
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
    teardown()
    expect(existsSync(runRoot!)).toBe(false)
    expect(reports).toEqual([])
    expect(failed).toBe(0)
  })

  it('reports and fails the run when this run wrote into any real root', () => {
    const env: NodeJS.ProcessEnv = {}
    const homeRoot = join(scratch('host-registry-isolation-real-'), 'hosts')
    const passwdRoot = join(scratch('host-registry-isolation-passwd-'), 'hosts')
    const reports: string[] = []
    let failed = 0
    const teardown = startHostRegistryIsolation({
      env,
      realRoots: [homeRoot, passwdRoot],
      temporaryDirectory: scratch('host-registry-isolation-tmp-'),
      readParents: () => TABLE,
      ancestorPid: RUN,
      report: (text) => reports.push(text),
      fail: () => {
        failed += 1
      }
    })
    // A child spawned without HOME resolves the password database's home.
    entry(passwdRoot, 'b', 600)
    teardown()
    expect(failed).toBe(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain(
      `FAILED: this test run wrote into the real Host registry ${passwdRoot}.`
    )
    expect(reports[0]).not.toContain(homeRoot)
    expect(reports[0]).toContain(`created ${'b'.repeat(16)}.json (this-run): pid 600`)
    expect(reports[0]).toContain(HOST_REGISTRY_ROOT_ENV)
  })

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
