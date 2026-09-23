import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TASKWRAITH_HOST_SOCKET_FILE,
  taskWraithHostSocketPath
} from '../shared/taskWraithHostPaths.node'
import {
  HOST_REGISTRY_ROOT_ENV,
  HOST_REGISTRY_SCHEMA,
  HOST_REGISTRY_SWEEP_MIN_AGE_MS,
  HostRegistryPublisher,
  createHostRegistryPublisherFromEnvironment,
  decodeHostRegistryEntry,
  hostRegistryEntryId,
  hostRegistryEntryPath,
  hostRegistryDefaultRoot,
  readHostRegistry,
  readHostRegistryEntry,
  removeHostRegistryEntryFor,
  removeHostRegistryEntryIfStill,
  resolveHostRegistryRoot,
  sweepHostRegistry,
  type HostRegistryEntry
} from './HostRegistry'
import type { HostRegistryEntryInput, HostRegistryPublisherPort } from './HostRegistryPort'
import type { ProcessBirthObservation } from './ProcessBirthIdentity'

const temporary: string[] = []
afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporary.push(path)
  return path
}

const NOW = new Date('2026-09-23T00:00:00.000Z')
const BORN = 'a'.repeat(64)
const live = (birthIdentity: string): ProcessBirthObservation => ({
  state: 'live',
  birthIdentity,
  startedAtMs: null
})

function input(profilePath: string, pid: number): HostRegistryEntryInput {
  return {
    profilePath,
    pid,
    startedAt: '2026-09-23T00:00:00.000Z',
    hostId: 'host-abc',
    bootEpoch: 'e'.repeat(64),
    payloadVersion: `sha256:${'f'.repeat(64)}`,
    persist: false,
    leaseMode: 'lease',
    holders: 1,
    implicitHolders: 0,
    lifetimePhase: 'held'
  }
}

function publisher(
  root: string,
  profilePath: string,
  pid = 4242,
  extra: Partial<ConstructorParameters<typeof HostRegistryPublisher>[0]> = {}
): HostRegistryPublisher {
  return new HostRegistryPublisher({
    root,
    profilePath,
    pid,
    cliPath: '/repo/out/host/host-runtime/cli.js',
    nodeExecutable: '/usr/local/bin/node',
    observeSelf: () => live(BORN),
    now: () => NOW,
    ...extra
  })
}

function writeEntry(root: string, entry: HostRegistryEntry): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = hostRegistryEntryPath(root, entry.profilePath)
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  return path
}

function entryFor(
  profilePath: string,
  pid: number,
  birthIdentity: string | null
): HostRegistryEntry {
  return {
    schema: HOST_REGISTRY_SCHEMA,
    profilePath,
    pid,
    birthIdentity,
    startedAt: '2026-09-23T00:00:00.000Z',
    hostId: 'host-abc',
    bootEpoch: 'e'.repeat(64),
    payloadVersion: null,
    socketPath: taskWraithHostSocketPath(profilePath),
    discoveryPath: join(profilePath, 'taskwraith-host-v2.json'),
    cliPath: '/repo/out/host/host-runtime/cli.js',
    nodeExecutable: '/usr/local/bin/node',
    persist: false,
    leaseMode: 'lease',
    writtenAt: '2026-09-23T00:00:00.000Z',
    beatSeq: 3,
    holders: 1,
    implicitHolders: 0,
    lifetimePhase: 'held'
  }
}

describe('HostRegistry root and naming', () => {
  it('resolves the root from the env override or ~/.taskwraith/hosts', () => {
    const home = join('/home/tw', '.taskwraith', 'hosts')
    expect(hostRegistryDefaultRoot('/home/tw')).toBe(home)
    expect(resolveHostRegistryRoot({}, '/home/tw', {})).toBe(home)
    expect(
      resolveHostRegistryRoot({ [HOST_REGISTRY_ROOT_ENV]: '/tmp/registry ' }, '/home/tw', {})
    ).toBe('/tmp/registry')
    expect(resolveHostRegistryRoot({ [HOST_REGISTRY_ROOT_ENV]: 'relative' }, '/home/tw', {})).toBe(
      home
    )
  })

  it("falls back to this process's override when a hand-built env names none, never to HOME", () => {
    const fallback = { [HOST_REGISTRY_ROOT_ENV]: '/run/registry' }
    expect(resolveHostRegistryRoot({ PATH: '' }, '/home/tw', fallback)).toBe('/run/registry')
    expect(
      resolveHostRegistryRoot({ [HOST_REGISTRY_ROOT_ENV]: 'relative' }, '/home/tw', fallback)
    ).toBe('/run/registry')
    expect(
      resolveHostRegistryRoot({ [HOST_REGISTRY_ROOT_ENV]: '/own/registry' }, '/home/tw', fallback)
    ).toBe('/own/registry')
    // The default fallback is process.env: a test's `{ PATH: '' }` inherits
    // the run's root instead of resolving the real home.
    vi.stubEnv(HOST_REGISTRY_ROOT_ENV, '/stubbed/registry')
    try {
      expect(resolveHostRegistryRoot({ PATH: '' }, '/home/tw')).toBe('/stubbed/registry')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('builds the production publisher on the env override root, never on HOME when it is set', () => {
    const root = join(scratch('host-registry-env-'), 'hosts')
    const profile = scratch('host-registry-profile-env-')
    // A stand-in HOME, so a publisher that ignored the override still could
    // never write into the real ~/.taskwraith/hosts.
    const home = scratch('host-registry-home-')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    try {
      expect(homedir()).toBe(home)
      const registry = createHostRegistryPublisherFromEnvironment({
        profilePath: profile,
        env: { [HOST_REGISTRY_ROOT_ENV]: root },
        cliPath: '/repo/out/host/host-runtime/cli.js',
        nodeExecutable: process.execPath
      })
      registry.publish(input(profile, process.pid))
      expect(registry.entryPath).toBe(hostRegistryEntryPath(root, profile))
      expect(readHostRegistryEntry(root, profile)).toMatchObject({
        kind: 'present',
        entry: { cliPath: '/repo/out/host/host-runtime/cli.js', nodeExecutable: process.execPath }
      })
      expect(existsSync(join(home, '.taskwraith'))).toBe(false)
      registry.remove()
      expect(existsSync(hostRegistryEntryPath(root, profile))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('names the entry by the exact suffix the socket directory uses', () => {
    const profile = '/Users/someone/Library/Application Support/taskwraith'
    const socketDirectory = basename(dirname(taskWraithHostSocketPath(profile, 'darwin')))
    expect(socketDirectory.endsWith(`-${hostRegistryEntryId(profile)}`)).toBe(true)
    expect(hostRegistryEntryPath('/r', profile)).toBe(
      join('/r', `${hostRegistryEntryId(profile)}.json`)
    )
  })
})

describe('HostRegistryPublisher', () => {
  it('publishes an owner-only D8 entry under a private root and reads it back present', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    const registry = publisher(root, profile)
    registry.publish(input(profile, 4242))
    const path = hostRegistryEntryPath(root, profile)
    expect(registry.entryPath).toBe(path)
    const raw = readFileSync(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(Object.keys(JSON.parse(raw))).toEqual([
      'schema',
      'profilePath',
      'pid',
      'birthIdentity',
      'startedAt',
      'hostId',
      'bootEpoch',
      'payloadVersion',
      'socketPath',
      'discoveryPath',
      'cliPath',
      'nodeExecutable',
      'persist',
      'leaseMode',
      'writtenAt',
      'beatSeq',
      'holders',
      'implicitHolders',
      'lifetimePhase'
    ])
    expect(JSON.parse(raw)).toMatchObject({
      schema: HOST_REGISTRY_SCHEMA,
      profilePath: profile,
      pid: 4242,
      birthIdentity: BORN,
      hostId: 'host-abc',
      bootEpoch: 'e'.repeat(64),
      socketPath: taskWraithHostSocketPath(profile),
      discoveryPath: join(profile, 'taskwraith-host-v2.json'),
      cliPath: '/repo/out/host/host-runtime/cli.js',
      nodeExecutable: '/usr/local/bin/node',
      persist: false,
      leaseMode: 'lease',
      writtenAt: NOW.toISOString(),
      beatSeq: 0,
      holders: 1,
      implicitHolders: 0,
      lifetimePhase: 'held'
    })
    if (process.platform !== 'win32') {
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(registry.check()).toBe('present')
    expect(readHostRegistryEntry(root, profile)).toMatchObject({
      kind: 'present',
      entry: { pid: 4242 }
    })
  })

  it('records a null birth identity when its own birth is unobservable, and only for its own pid', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    const unavailable = publisher(root, profile, 4242, {
      observeSelf: () => ({ state: 'identity_unavailable' })
    })
    unavailable.publish(input(profile, 4242))
    expect(unavailable.current?.birthIdentity).toBeNull()
    expect(unavailable.check()).toBe('present')
    const foreignPid = publisher(root, profile, 4242)
    foreignPid.publish(input(profile, 9999))
    expect(foreignPid.current?.birthIdentity).toBeNull()
  })

  it('refreshes writtenAt, beatSeq and the counters in place', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    let clock = NOW.getTime()
    const registry = publisher(root, profile, 4242, { now: () => new Date(clock) })
    registry.publish(input(profile, 4242))
    clock += 60_000
    registry.refresh({ holders: 3, implicitHolders: 1, lifetimePhase: 'grace' })
    clock += 60_000
    registry.refresh({ holders: 0, implicitHolders: 0, lifetimePhase: 'draining' })
    const read = readHostRegistryEntry(root, profile)
    expect(read).toMatchObject({
      kind: 'present',
      entry: {
        pid: 4242,
        bootEpoch: 'e'.repeat(64),
        beatSeq: 2,
        holders: 0,
        implicitHolders: 0,
        lifetimePhase: 'draining',
        writtenAt: new Date(NOW.getTime() + 120_000).toISOString()
      }
    })
    expect(registry.check()).toBe('present')
  })

  it('never recreates a deleted entry or overwrites a foreign one on refresh, so the self-check sees them', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    // Typed as the production server holds it.
    const registry: HostRegistryPublisherPort = publisher(root, profile)
    registry.publish(input(profile, 4242))
    const path = hostRegistryEntryPath(root, profile)
    rmSync(path)
    registry.refresh({ holders: 2, implicitHolders: 0, lifetimePhase: 'held' })
    expect(existsSync(path)).toBe(false)
    expect(registry.check()).toBe('missing')
    // The whole root removed (an uninstall): still missing, still not recreated.
    rmSync(root, { recursive: true, force: true })
    registry.refresh({ holders: 2, implicitHolders: 0, lifetimePhase: 'held' })
    expect(existsSync(root)).toBe(false)
    expect(registry.check()).toBe('missing')
    const successor = writeEntry(root, entryFor(profile, 5151, BORN))
    const successorBytes = readFileSync(successor, 'utf8')
    registry.refresh({ holders: 2, implicitHolders: 0, lifetimePhase: 'held' })
    expect(readFileSync(successor, 'utf8')).toBe(successorBytes)
    expect(registry.check()).toBe('foreign')
  })

  it('repairs an unreadable entry on refresh, and publishes on refresh after a failed publish', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    const registry = publisher(root, profile)
    registry.publish(input(profile, 4242))
    const path = hostRegistryEntryPath(root, profile)
    writeFileSync(path, '{not json\n', { mode: 0o600 })
    expect(registry.check()).toBe('unreadable')
    registry.refresh({ holders: 1, implicitHolders: 0, lifetimePhase: 'held' })
    expect(registry.check()).toBe('present')
    expect(readHostRegistryEntry(root, profile)).toMatchObject({ entry: { beatSeq: 1 } })

    // A path that is a directory can be neither read nor replaced: unreadable,
    // never missing, until the refresh after it clears.
    rmSync(path)
    mkdirSync(path)
    registry.refresh({ holders: 1, implicitHolders: 0, lifetimePhase: 'held' })
    expect(registry.check()).toBe('unreadable')
    rmSync(path, { recursive: true })
    registry.refresh({ holders: 1, implicitHolders: 0, lifetimePhase: 'held' })
    expect(registry.check()).toBe('present')

    const late = join(scratch('host-registry-'), 'hosts')
    writeFileSync(late, 'a file where the root should be\n')
    const retry = publisher(late, profile)
    retry.publish(input(profile, 4242))
    expect(retry.check()).toBe('unreadable')
    rmSync(late)
    retry.refresh({ holders: 1, implicitHolders: 0, lifetimePhase: 'held' })
    expect(retry.check()).toBe('present')
  })

  it('checks missing after the entry is deleted and foreign when another Host wrote it', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    const registry = publisher(root, profile)
    registry.publish(input(profile, 4242))
    const path = hostRegistryEntryPath(root, profile)
    rmSync(path)
    expect(registry.check()).toBe('missing')
    writeEntry(root, entryFor(profile, 5151, BORN))
    expect(registry.check()).toBe('foreign')
    writeEntry(root, entryFor(profile, 4242, 'b'.repeat(64)))
    expect(registry.check()).toBe('foreign')
    writeEntry(root, { ...entryFor(profile, 4242, BORN), bootEpoch: 'x'.repeat(64) })
    expect(registry.check()).toBe('foreign')
    writeEntry(root, entryFor(profile, 4242, BORN))
    expect(registry.check()).toBe('present')
    rmSync(root, { recursive: true, force: true })
    expect(registry.check()).toBe('missing')
  })

  it('checks unreadable on malformed, mis-permissioned or unreadable entries, never missing', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    const registry = publisher(root, profile)
    registry.publish(input(profile, 4242))
    const path = hostRegistryEntryPath(root, profile)
    writeFileSync(path, '{not json\n', { mode: 0o600 })
    expect(registry.check()).toBe('unreadable')
    writeFileSync(path, `${JSON.stringify({ schema: 'other' })}\n`, { mode: 0o600 })
    expect(registry.check()).toBe('unreadable')
    if (process.platform !== 'win32') {
      writeFileSync(path, `${JSON.stringify(entryFor(profile, 4242, BORN))}\n`, { mode: 0o600 })
      chmodSync(path, 0o644)
      expect(registry.check()).toBe('unreadable')
      chmodSync(path, 0o600)
      expect(registry.check()).toBe('present')
      if (process.getuid?.() !== 0) {
        chmodSync(root, 0o000)
        try {
          expect(registry.check()).toBe('unreadable')
        } finally {
          chmodSync(root, 0o700)
        }
      }
    }
  })

  it('never throws from publish, logs the failure, and then checks unreadable rather than missing', () => {
    const parent = scratch('host-registry-')
    const root = join(parent, 'hosts')
    writeFileSync(root, 'a file where the root should be\n')
    const profile = scratch('host-registry-profile-')
    const log = vi.fn()
    const registry = publisher(root, profile, 4242, { log })
    expect(() => registry.publish(input(profile, 4242))).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[host-registry\] publish failed: /))
    expect(registry.check()).toBe('unreadable')
    expect(() =>
      registry.refresh({ holders: 1, implicitHolders: 0, lifetimePhase: 'held' })
    ).not.toThrow()
    expect(() => registry.remove()).not.toThrow()
  })

  it('removes only the file it last wrote and leaves a foreign successor entry alone', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    const registry = publisher(root, profile)
    registry.publish(input(profile, 4242))
    const path = hostRegistryEntryPath(root, profile)
    registry.remove()
    expect(existsSync(path)).toBe(false)
    registry.remove()
    registry.publish(input(profile, 4242))
    writeEntry(root, entryFor(profile, 5151, BORN))
    registry.remove()
    expect(readHostRegistryEntry(root, profile)).toMatchObject({
      kind: 'present',
      entry: { pid: 5151 }
    })
  })

  it('removeHostRegistryEntryFor deletes only the entry of that exact Host, never a same-pid successor', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    const dead = { pid: 5151, birthIdentity: BORN, bootEpoch: 'e'.repeat(64) }
    writeEntry(root, entryFor(profile, 5151, BORN))
    expect(removeHostRegistryEntryFor(root, profile, { ...dead, pid: 4242 })).toBe(false)
    // The operating system handed a successor Host the same pid: another
    // birth, or the same birth with another boot epoch, is not the dead Host.
    expect(
      removeHostRegistryEntryFor(root, profile, { ...dead, birthIdentity: 'b'.repeat(64) })
    ).toBe(false)
    expect(removeHostRegistryEntryFor(root, profile, { ...dead, bootEpoch: 'x'.repeat(64) })).toBe(
      false
    )
    expect(existsSync(hostRegistryEntryPath(root, profile))).toBe(true)
    expect(removeHostRegistryEntryFor(root, profile, dead)).toBe(true)
    expect(existsSync(hostRegistryEntryPath(root, profile))).toBe(false)
    expect(removeHostRegistryEntryFor(root, profile, dead)).toBe(false)
  })

  it('removeHostRegistryEntryIfStill keeps an entry replaced between the judged read and the unlink', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    const path = writeEntry(root, entryFor(profile, 5151, BORN))
    const successor = `${JSON.stringify(entryFor(profile, 6262, 'c'.repeat(64)))}\n`
    let judged = 0
    const removed = removeHostRegistryEntryIfStill(path, (entry) => {
      judged += 1
      // The dead Host's content passes the judge, and a successor renames its
      // entry over the path before the unlink runs.
      const temporary = join(root, '.successor.tmp')
      writeFileSync(temporary, successor, { mode: 0o600 })
      renameSync(temporary, path)
      return entry.pid === 5151
    })
    expect(judged).toBe(1)
    expect(removed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(successor)
    expect(removeHostRegistryEntryIfStill(path, (entry) => entry.pid === 6262)).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('reads a registry root replaced by a file as unreadable, never missing', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-')
    const registry = publisher(root, profile)
    registry.publish(input(profile, 4242))
    rmSync(root, { recursive: true })
    writeFileSync(root, 'a file where the root was\n')
    // ENOTDIR: the self-check may stop a Host on `missing` only.
    expect(registry.check()).toBe('unreadable')
    expect(readHostRegistryEntry(root, profile)).toMatchObject({ kind: 'unreadable' })
    expect(readHostRegistry(root)).toEqual({
      root,
      entries: [],
      unreadable: [{ path: root, error: expect.stringMatching(/ENOTDIR/) }]
    })
  })

  it.skipIf(process.platform === 'win32')(
    'tightens an existing group- or world-readable root to owner-only when it publishes',
    () => {
      const root = join(scratch('host-registry-'), 'hosts')
      mkdirSync(root, { mode: 0o755 })
      chmodSync(root, 0o755)
      const profile = scratch('host-registry-profile-')
      const registry = publisher(root, profile)
      registry.publish(input(profile, 4242))
      expect(statSync(root).mode & 0o777).toBe(0o700)
      chmodSync(root, 0o750)
      registry.refresh({ holders: 1, implicitHolders: 0, lifetimePhase: 'held' })
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(registry.check()).toBe('present')
    }
  )
})

describe('HostRegistry reader and decoder', () => {
  it('lists decodable entries, names unreadable files, and reads a missing root as empty', () => {
    const root = join(scratch('host-registry-'), 'hosts')
    expect(readHostRegistry(root)).toEqual({ root, entries: [], unreadable: [] })
    const profileA = scratch('host-registry-profile-a-')
    const profileB = scratch('host-registry-profile-b-')
    writeEntry(root, entryFor(profileA, 11, BORN))
    writeEntry(root, entryFor(profileB, 22, null))
    writeFileSync(join(root, `${'c'.repeat(16)}.json`), 'nope\n', { mode: 0o600 })
    writeFileSync(join(root, 'notes.txt'), 'ignored\n', { mode: 0o600 })
    const listing = readHostRegistry(root)
    expect(listing.entries.map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([11, 22])
    expect(listing.unreadable).toEqual([
      { path: join(root, `${'c'.repeat(16)}.json`), error: expect.stringMatching(/not JSON/) }
    ])
    expect(readHostRegistryEntry(root, join(root, 'no-such-profile'))).toMatchObject({
      kind: 'missing'
    })
  })

  it('fails closed on the wrong schema, a bad pid, or non-canonical timestamps', () => {
    const entry = entryFor('/profiles/p', 4242, BORN)
    expect(decodeHostRegistryEntry(entry)).toEqual({ ok: true, entry })
    expect(decodeHostRegistryEntry({ ...entry, schema: 'taskwraith.host-registry.v2' }).ok).toBe(
      false
    )
    expect(decodeHostRegistryEntry({ ...entry, pid: 0 }).ok).toBe(false)
    expect(decodeHostRegistryEntry({ ...entry, startedAt: '2026-09-23T00:00:00Z' }).ok).toBe(false)
    expect(decodeHostRegistryEntry({ ...entry, leaseMode: 'parent' }).ok).toBe(false)
    expect(decodeHostRegistryEntry({ ...entry, payloadVersion: 'sha1:abc' }).ok).toBe(false)
    expect(decodeHostRegistryEntry({ ...entry, lifetimePhase: 'HELD' }).ok).toBe(false)
    expect(decodeHostRegistryEntry({ ...entry, bootEpoch: null }).ok).toBe(true)
    expect(decodeHostRegistryEntry({ ...entry, profilePath: 'relative' }).ok).toBe(false)
    expect(decodeHostRegistryEntry('string').ok).toBe(false)
  })
})

describe('sweepHostRegistry', () => {
  const anHourLater = (): number => Date.now() + 3_600_000

  it('never sweeps a socket directory changed inside the minimum age, even with a dead socket', async () => {
    const parent = scratch('host-registry-')
    const root = join(parent, 'hosts')
    const temporaryDirectory = join(parent, 'tmp')
    mkdirSync(temporaryDirectory)
    const name = `twh2-501-${'b'.repeat(16)}`
    mkdirSync(join(temporaryDirectory, name))
    writeFileSync(join(temporaryDirectory, name, TASKWRAITH_HOST_SOCKET_FILE), '')
    const socketIsLive = vi.fn(async () => false)
    const young = await sweepHostRegistry({
      root,
      platform: 'darwin',
      temporaryDirectory,
      uid: 501,
      observe: async () => ({ state: 'dead' }),
      socketIsLive
    })
    expect(young.keptSocketDirectories).toEqual([name])
    expect(young.removedSocketDirectories).toEqual([])
    expect(socketIsLive).not.toHaveBeenCalled()
    expect(existsSync(join(temporaryDirectory, name, TASKWRAITH_HOST_SOCKET_FILE))).toBe(true)
    const justInside = await sweepHostRegistry({
      root,
      platform: 'darwin',
      temporaryDirectory,
      uid: 501,
      observe: async () => ({ state: 'dead' }),
      socketIsLive,
      now: () => Date.now() + HOST_REGISTRY_SWEEP_MIN_AGE_MS - 5_000
    })
    expect(justInside.keptSocketDirectories).toEqual([name])
    const old = await sweepHostRegistry({
      root,
      platform: 'darwin',
      temporaryDirectory,
      uid: 501,
      observe: async () => ({ state: 'dead' }),
      socketIsLive,
      now: anHourLater
    })
    expect(old.removedSocketDirectories).toEqual([name])
    expect(existsSync(join(temporaryDirectory, name))).toBe(false)
  })

  it('keeps an entry a successor Host replaced while the dead one was being judged', async () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const profile = scratch('host-registry-profile-successor-')
    writeEntry(root, entryFor(profile, 11, BORN))
    const observe = vi.fn(async (pid: number): Promise<ProcessBirthObservation> => {
      if (pid === 11) {
        // The successor publishes (atomic replace) between the listing and the removal.
        const successor = new HostRegistryPublisher({
          root,
          profilePath: profile,
          pid: 12,
          observeSelf: () => live('c'.repeat(64)),
          now: () => NOW
        })
        successor.publish(input(profile, 12))
        return { state: 'dead' }
      }
      return live('c'.repeat(64))
    })
    const report = await sweepHostRegistry({ root, platform: 'win32', observe })
    expect(report.removedEntries).toEqual([])
    expect(report.keptEntries).toEqual([hostRegistryEntryId(profile)])
    expect(readHostRegistryEntry(root, profile)).toMatchObject({
      kind: 'present',
      entry: { pid: 12, birthIdentity: 'c'.repeat(64) }
    })
  })

  it('removes entries whose pid is dead or born at another time and keeps live or unavailable ones', async () => {
    const root = join(scratch('host-registry-'), 'hosts')
    const dead = scratch('host-registry-profile-dead-')
    const reused = scratch('host-registry-profile-reused-')
    const alive = scratch('host-registry-profile-alive-')
    const unknown = scratch('host-registry-profile-unknown-')
    const legacy = scratch('host-registry-profile-legacy-')
    writeEntry(root, entryFor(dead, 11, BORN))
    writeEntry(root, entryFor(reused, 22, BORN))
    writeEntry(root, entryFor(alive, 33, BORN))
    writeEntry(root, entryFor(unknown, 44, BORN))
    writeEntry(root, entryFor(legacy, 55, null))
    const observe = vi.fn(async (pid: number): Promise<ProcessBirthObservation> => {
      if (pid === 11) return { state: 'dead' }
      if (pid === 22) return live('b'.repeat(64))
      if (pid === 44) return { state: 'identity_unavailable' }
      return live(BORN)
    })
    const report = await sweepHostRegistry({
      root,
      platform: 'win32',
      observe
    })
    expect([...report.removedEntries].sort()).toEqual(
      [hostRegistryEntryId(dead), hostRegistryEntryId(reused)].sort()
    )
    expect([...report.keptEntries].sort()).toEqual(
      [hostRegistryEntryId(alive), hostRegistryEntryId(unknown), hostRegistryEntryId(legacy)].sort()
    )
    expect(existsSync(hostRegistryEntryPath(root, dead))).toBe(false)
    expect(existsSync(hostRegistryEntryPath(root, reused))).toBe(false)
    expect(existsSync(hostRegistryEntryPath(root, alive))).toBe(true)
    expect(existsSync(hostRegistryEntryPath(root, unknown))).toBe(true)
    expect(existsSync(hostRegistryEntryPath(root, legacy))).toBe(true)
    expect(report.removedSocketDirectories).toEqual([])
  })

  it('removes dead socket directories, never a live socket, and keeps one whose Host is verified alive', async () => {
    const parent = scratch('host-registry-')
    const root = join(parent, 'hosts')
    const temporaryDirectory = join(parent, 'tmp')
    mkdirSync(temporaryDirectory)
    const uid = '501'
    const profileLive = scratch('host-registry-profile-live-')
    const profileWedged = scratch('host-registry-profile-wedged-')
    const profileDead = scratch('host-registry-profile-dead-')
    const profileOrphan = scratch('host-registry-profile-orphan-')
    const directory = (profile: string) =>
      join(temporaryDirectory, `twh2-${uid}-${hostRegistryEntryId(profile)}`)
    for (const profile of [profileLive, profileWedged, profileDead, profileOrphan]) {
      mkdirSync(directory(profile), { mode: 0o700 })
      writeFileSync(join(directory(profile), TASKWRAITH_HOST_SOCKET_FILE), '', { mode: 0o600 })
    }
    // An empty leftover directory (socket already gone) and unrelated names.
    mkdirSync(join(temporaryDirectory, `twh2-${uid}-${'d'.repeat(16)}`))
    mkdirSync(join(temporaryDirectory, `twh2-999-${'e'.repeat(16)}`))
    mkdirSync(join(temporaryDirectory, `tw-${uid}-${'f'.repeat(16)}`))
    writeFileSync(join(temporaryDirectory, `twh2-${uid}-${'1'.repeat(16)}`), 'a file, not a dir\n')
    writeEntry(root, entryFor(profileLive, 11, BORN))
    writeEntry(root, entryFor(profileWedged, 22, BORN))
    writeEntry(root, entryFor(profileDead, 33, BORN))
    const socketIsLive = vi.fn(async (socketPath: string) =>
      socketPath.startsWith(directory(profileLive))
    )
    const observe = vi.fn(
      async (pid: number): Promise<ProcessBirthObservation> =>
        pid === 33 ? { state: 'dead' } : live(BORN)
    )
    const report = await sweepHostRegistry({
      root,
      platform: 'darwin',
      temporaryDirectory,
      uid,
      observe,
      socketIsLive,
      now: anHourLater
    })
    expect(report.removedEntries).toEqual([hostRegistryEntryId(profileDead)])
    expect([...report.removedSocketDirectories].sort()).toEqual(
      [
        basename(directory(profileDead)),
        basename(directory(profileOrphan)),
        `twh2-${uid}-${'d'.repeat(16)}`
      ].sort()
    )
    expect([...report.keptSocketDirectories].sort()).toEqual(
      [basename(directory(profileLive)), basename(directory(profileWedged))].sort()
    )
    expect(existsSync(directory(profileLive))).toBe(true)
    expect(existsSync(join(directory(profileLive), TASKWRAITH_HOST_SOCKET_FILE))).toBe(true)
    expect(existsSync(directory(profileWedged))).toBe(true)
    expect(existsSync(directory(profileDead))).toBe(false)
    expect(existsSync(directory(profileOrphan))).toBe(false)
    expect(existsSync(join(temporaryDirectory, `twh2-${uid}-${'d'.repeat(16)}`))).toBe(false)
    expect(existsSync(join(temporaryDirectory, `twh2-999-${'e'.repeat(16)}`))).toBe(true)
    expect(existsSync(join(temporaryDirectory, `tw-${uid}-${'f'.repeat(16)}`))).toBe(true)
    expect(existsSync(join(temporaryDirectory, `twh2-${uid}-${'1'.repeat(16)}`))).toBe(true)
    // The live socket was probed and answered; it was never unlinked.
    expect(socketIsLive).toHaveBeenCalledWith(
      join(directory(profileLive), TASKWRAITH_HOST_SOCKET_FILE)
    )
  })

  it('never unlinks a socket re-bound while the dead one was being probed', async () => {
    const parent = scratch('host-registry-')
    const root = join(parent, 'hosts')
    const temporaryDirectory = join(parent, 'tmp')
    mkdirSync(temporaryDirectory)
    const name = `twh2-501-${'c'.repeat(16)}`
    const socketPath = join(temporaryDirectory, name, TASKWRAITH_HOST_SOCKET_FILE)
    mkdirSync(join(temporaryDirectory, name))
    writeFileSync(socketPath, 'dead socket\n')
    const rebound = 'a starting Host bound here\n'
    const report = await sweepHostRegistry({
      root,
      platform: 'darwin',
      temporaryDirectory,
      uid: 501,
      observe: async () => ({ state: 'dead' }),
      socketIsLive: async (probed) => {
        // The probe saw the dead socket; a starting Host then replaced it.
        unlinkSync(probed)
        writeFileSync(probed, rebound)
        return false
      },
      now: anHourLater
    })
    expect(report.keptSocketDirectories).toEqual([name])
    expect(report.removedSocketDirectories).toEqual([])
    expect(readFileSync(socketPath, 'utf8')).toBe(rebound)
  })

  it('leaves a non-empty socket directory in place and reports it kept', async () => {
    const parent = scratch('host-registry-')
    const root = join(parent, 'hosts')
    const temporaryDirectory = join(parent, 'tmp')
    mkdirSync(temporaryDirectory)
    const name = `twh2-501-${'a'.repeat(16)}`
    mkdirSync(join(temporaryDirectory, name))
    writeFileSync(join(temporaryDirectory, name, TASKWRAITH_HOST_SOCKET_FILE), '')
    writeFileSync(join(temporaryDirectory, name, 'stray.log'), 'x\n')
    const report = await sweepHostRegistry({
      root,
      platform: 'linux',
      temporaryDirectory,
      uid: 501,
      observe: async () => ({ state: 'dead' }),
      socketIsLive: async () => false,
      now: anHourLater
    })
    expect(report.keptSocketDirectories).toEqual([name])
    expect(existsSync(join(temporaryDirectory, name))).toBe(true)
    expect(existsSync(join(temporaryDirectory, name, TASKWRAITH_HOST_SOCKET_FILE))).toBe(false)
  })
})
