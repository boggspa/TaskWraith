import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareKimiIsolatedHome, type KimiHomeFs } from './KimiAcpHome'
import {
  KimiOAuthCredentialAuthority,
  type KimiOAuthCredentialAuthorityOptions
} from './KimiOAuthCredentialLease'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function privateDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 })
  await fs.chmod(path, 0o700)
}

async function privateFile(path: string, value: string): Promise<void> {
  await fs.writeFile(path, value, { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(path, 0o600)
}

function credential(expiry: number, refreshToken: string): string {
  return JSON.stringify({ expires_at: expiry, refresh_token: refreshToken })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function fixture(): Promise<{
  root: string
  sourceHome: string
  boundaryRoot: string
  homeA: string
  homeB: string
}> {
  const root = await fs.mkdtemp(join(tmpdir(), 'tw-kimi-oauth-'))
  roots.push(root)
  await fs.chmod(root, 0o700)
  const sourceHome = join(root, 'source')
  const boundaryRoot = join(root, 'seats')
  const homeA = join(boundaryRoot, 'a')
  const homeB = join(boundaryRoot, 'b')
  await privateDirectory(join(sourceHome, 'credentials'))
  await privateDirectory(join(sourceHome, 'oauth'))
  await privateDirectory(homeA)
  await privateDirectory(homeB)
  await privateFile(join(sourceHome, 'credentials', 'kimi-code.json'), credential(1_000, 'R0'))
  await privateFile(join(sourceHome, 'oauth', 'kimi-code'), 'oauth-R0')
  await privateFile(join(sourceHome, 'device_id'), 'device-R0')
  return { root, sourceHome, boundaryRoot, homeA, homeB }
}

function authority(input: {
  pid: number
  instanceId: string
  live?: ReadonlySet<number>
  identities?: ReadonlyMap<number, string>
  onTransition?: KimiOAuthCredentialAuthorityOptions['onTransition']
  onLockTransition?: KimiOAuthCredentialAuthorityOptions['onLockTransition']
  transitionWaitMs?: number
}): KimiOAuthCredentialAuthority {
  return new KimiOAuthCredentialAuthority({
    pid: input.pid,
    instanceId: input.instanceId,
    isProcessAlive: (pid) => input.live?.has(pid) ?? false,
    processIdentity: async (pid) => input.identities?.get(pid) ?? null,
    transitionWaitMs: input.transitionWaitMs ?? 250,
    onTransition: input.onTransition,
    onLockTransition: input.onLockTransition
  })
}

function request(f: Awaited<ReturnType<typeof fixture>>, isolatedHome = f.homeA) {
  return { sourceHome: f.sourceHome, boundaryRoot: f.boundaryRoot, isolatedHome }
}

describe('KimiOAuthCredentialAuthority', () => {
  it('serializes a borrowed OAuth credential across its full private-home lifetime', async () => {
    const f = await fixture()
    const first = authority({ pid: 101, instanceId: 'first' })
    const acquired = await first.acquire(request(f))
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    await acquired.lease.seedIntoIsolatedHome()

    const contender = authority({
      pid: 202,
      instanceId: 'contender',
      live: new Set([101])
    })
    const blocked = await contender.acquire(request(f, f.homeB))
    expect(blocked).toMatchObject({ ok: false, reason: 'busy' })

    await expect(acquired.lease.commitAndRelease()).resolves.toBe('unchanged')
    await expect(contender.acquire(request(f, f.homeB))).resolves.toMatchObject({
      ok: true
    })
  })

  it('recovers a dead-owner rotation before seeding the next seat and scrubs the crashed home', async () => {
    const f = await fixture()
    const first = authority({
      pid: 301,
      instanceId: 'before-crash',
      identities: new Map([[401, 'child-birth-a']])
    })
    const acquired = await first.acquire(request(f))
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    await acquired.lease.seedIntoIsolatedHome()
    await acquired.lease.noteProviderProcess(401)
    await privateDirectory(join(f.homeA, 'sessions'))
    await privateFile(join(f.homeA, 'sessions', 'continuity.jsonl'), '{}')
    await privateFile(join(f.homeA, 'credentials', 'kimi-code.json'), credential(2_000, 'R1'))
    await privateFile(join(f.homeA, 'oauth', 'kimi-code'), 'oauth-R1')

    // Simulate a new app process: both the old Electron owner and its provider
    // child are gone. Acquire must recover R1 before it snapshots home B.
    const restarted = authority({ pid: 302, instanceId: 'after-crash' })
    const next = await restarted.acquire(request(f, f.homeB))
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(await fs.readFile(join(f.sourceHome, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      credential(2_000, 'R1')
    )
    expect(await fs.readFile(join(f.sourceHome, 'oauth', 'kimi-code'), 'utf8')).toBe('oauth-R1')
    await expect(fs.access(join(f.homeA, 'credentials'))).rejects.toThrow()
    expect(await fs.readFile(join(f.homeA, 'sessions', 'continuity.jsonl'), 'utf8')).toBe('{}')

    await next.lease.seedIntoIsolatedHome()
    expect(await fs.readFile(join(f.homeB, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      credential(2_000, 'R1')
    )
    await expect(next.lease.commitAndRelease()).resolves.toBe('unchanged')
  })

  it('never steals a stale-parent lease while its exact provider child is still alive', async () => {
    const f = await fixture()
    const first = authority({
      pid: 501,
      instanceId: 'parent',
      identities: new Map([[601, 'child-birth-live']])
    })
    const acquired = await first.acquire(request(f))
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    await acquired.lease.seedIntoIsolatedHome()
    await acquired.lease.noteProviderProcess(601)
    await privateFile(join(f.homeA, 'credentials', 'kimi-code.json'), credential(2_000, 'R1'))

    const restarted = authority({
      pid: 502,
      instanceId: 'restart',
      live: new Set([601]),
      identities: new Map([[601, 'child-birth-live']])
    })
    const blocked = await restarted.acquire(request(f, f.homeB))
    expect(blocked).toMatchObject({ ok: false, reason: 'error' })
    expect(await fs.readFile(join(f.sourceHome, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      credential(1_000, 'R0')
    )
    expect(await fs.readFile(join(f.homeA, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      credential(2_000, 'R1')
    )
  })

  it('rejects a stale writer after the source authority advances independently', async () => {
    const f = await fixture()
    const owner = authority({
      pid: 701,
      instanceId: 'owner',
      identities: new Map([[702, 'child-birth']])
    })
    const acquired = await owner.acquire(request(f))
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    await acquired.lease.seedIntoIsolatedHome()
    await acquired.lease.noteProviderProcess(702)
    await privateFile(join(f.homeA, 'credentials', 'kimi-code.json'), credential(2_000, 'R1'))
    const independent = credential(3_000, 'R-independent')
    await privateFile(join(f.sourceHome, 'credentials', 'kimi-code.json'), independent)

    await expect(acquired.lease.commitAndRelease()).resolves.toBe('stale-rejected')
    expect(await fs.readFile(join(f.sourceHome, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      independent
    )
  })

  it('retains the durable lease and candidate when a private-path swap blocks commit', async () => {
    const f = await fixture()
    const owner = authority({
      pid: 801,
      instanceId: 'owner',
      identities: new Map([[802, 'child-birth']])
    })
    const acquired = await owner.acquire(request(f))
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    await acquired.lease.seedIntoIsolatedHome()
    await acquired.lease.noteProviderProcess(802)
    const candidate = credential(2_000, 'R1')
    await privateFile(join(f.homeA, 'credentials', 'kimi-code.json'), candidate)

    const sourceCredential = join(f.sourceHome, 'credentials', 'kimi-code.json')
    const backup = `${sourceCredential}.backup`
    const outside = join(f.root, 'outside-secret')
    await privateFile(outside, credential(9_000, 'OUTSIDE'))
    await fs.rename(sourceCredential, backup)
    await fs.symlink(outside, sourceCredential)

    await expect(acquired.lease.commitAndRelease()).rejects.toThrow()
    await expect(
      fs.access(join(f.sourceHome, '.taskwraith-oauth-authority-v1', 'lease.json'))
    ).resolves.toBeUndefined()
    expect(await fs.readFile(join(f.homeA, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      candidate
    )
    expect(await fs.readFile(outside, 'utf8')).toBe(credential(9_000, 'OUTSIDE'))

    await fs.unlink(sourceCredential)
    await fs.rename(backup, sourceCredential)
    await expect(acquired.lease.commitAndRelease()).resolves.toBe('rotated')
    expect(await fs.readFile(sourceCredential, 'utf8')).toBe(candidate)
  })

  it('fails closed on a symlinked transition lock without removing its target', async () => {
    const f = await fixture()
    const authorityRoot = join(f.sourceHome, '.taskwraith-oauth-authority-v1')
    const outside = join(f.root, 'outside-lock-target')
    await privateDirectory(authorityRoot)
    await privateDirectory(outside)
    await privateFile(join(outside, 'sentinel'), 'keep')
    await fs.symlink(outside, join(authorityRoot, 'transition.lock'))

    const result = await authority({ pid: 901, instanceId: 'owner' }).acquire(request(f))
    expect(result).toMatchObject({ ok: false, reason: 'error' })
    expect(await fs.readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep')
  })

  it('does not let a delayed stale observer remove a newer live lock generation', async () => {
    const f = await fixture()
    const authorityRoot = join(f.sourceHome, '.taskwraith-oauth-authority-v1')
    const lockPath = join(authorityRoot, 'transition.lock')
    await privateDirectory(lockPath)
    await privateFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({ version: 1, pid: 1_201, instanceId: 'dead', createdAt: Date.now() - 5_000 })
    )

    const staleObserved = deferred()
    const releaseStaleObserver = deferred()
    const delayedGuardHeld = deferred()
    const releaseDelayedGuard = deferred()
    let delayedObservedOnce = false
    let delayedGuardOnce = false
    const delayed = authority({
      pid: 1_202,
      instanceId: 'delayed-stale-observer',
      live: new Set([1_203]),
      transitionWaitMs: 2_000,
      onLockTransition: async (point) => {
        if (point === 'after-stale-observed' && !delayedObservedOnce) {
          delayedObservedOnce = true
          staleObserved.resolve()
          await releaseStaleObserver.promise
        }
        if (point === 'after-reclaim-guard-acquired' && !delayedGuardOnce) {
          delayedGuardOnce = true
          delayedGuardHeld.resolve()
          await releaseDelayedGuard.promise
        }
      }
    })
    const delayedAcquire = delayed.acquire(request(f, f.homeB))
    await staleObserved.promise

    const winnerLockHeld = deferred()
    const releaseWinnerLock = deferred()
    let winnerPaused = false
    const winner = authority({
      pid: 1_203,
      instanceId: 'winner',
      onLockTransition: async (point) => {
        if (point === 'after-lock-acquired' && !winnerPaused) {
          winnerPaused = true
          winnerLockHeld.resolve()
          await releaseWinnerLock.promise
        }
      }
    })
    const winnerAcquire = winner.acquire(request(f))
    await winnerLockHeld.promise
    const winnerIdentity = await fs.lstat(lockPath)

    releaseStaleObserver.resolve()
    await delayedGuardHeld.promise
    const whileDelayedGuardHeld = await fs.lstat(lockPath)
    expect({ dev: whileDelayedGuardHeld.dev, ino: whileDelayedGuardHeld.ino }).toEqual({
      dev: winnerIdentity.dev,
      ino: winnerIdentity.ino
    })

    releaseDelayedGuard.resolve()
    releaseWinnerLock.resolve()
    const [winnerResult, delayedResult] = await Promise.all([winnerAcquire, delayedAcquire])
    expect(winnerResult.ok).toBe(true)
    expect(delayedResult).toMatchObject({ ok: false, reason: 'busy' })
    if (winnerResult.ok) {
      await expect(winnerResult.lease.commitAndRelease()).resolves.toBe('unchanged')
    }
  })

  it('fails closed instead of reclaiming an abandoned reclaim guard', async () => {
    const f = await fixture()
    const authorityRoot = join(f.sourceHome, '.taskwraith-oauth-authority-v1')
    const guardPath = join(authorityRoot, 'transition.reclaim.lock')
    await privateDirectory(guardPath)
    await privateFile(
      join(guardPath, 'owner.json'),
      JSON.stringify({ version: 1, pid: 1_301, instanceId: 'dead', createdAt: 0 })
    )

    const result = await authority({
      pid: 1_302,
      instanceId: 'blocked-by-reclaim-guard',
      transitionWaitMs: 50
    }).acquire(request(f))
    expect(result).toMatchObject({ ok: false, reason: 'error' })
    await expect(fs.lstat(guardPath)).resolves.toMatchObject({})
  })

  it('treats a missing owned transition lock at release as an authority failure', async () => {
    const f = await fixture()
    const lockPath = join(f.sourceHome, '.taskwraith-oauth-authority-v1', 'transition.lock')
    let removed = false
    const result = await authority({
      pid: 1_401,
      instanceId: 'missing-release-lock',
      onLockTransition: async (point) => {
        if (point === 'after-lock-acquired' && !removed) {
          removed = true
          await fs.rm(lockPath, { recursive: true, force: true })
        }
      }
    }).acquire(request(f))
    expect(result).toMatchObject({ ok: false, reason: 'error' })
    await expect(
      fs.access(join(f.sourceHome, '.taskwraith-oauth-authority-v1', 'lease.json'))
    ).resolves.toBeUndefined()
  })

  it.each([
    'after-primary-commit',
    'after-committed-marker',
    'after-scrub',
    'before-record-remove'
  ] as const)(
    'replays a crash at %s without losing the rotation or residue cleanup',
    async (point) => {
      const f = await fixture()
      let crashed = false
      const first = authority({
        pid: 1_001,
        instanceId: `before-${point}`,
        identities: new Map([[1_002, 'child-before-crash']]),
        onTransition: (observed) => {
          if (!crashed && observed === point) {
            crashed = true
            throw new Error(`injected crash at ${point}`)
          }
        }
      })
      const acquired = await first.acquire(request(f))
      expect(acquired.ok).toBe(true)
      if (!acquired.ok) return
      await acquired.lease.seedIntoIsolatedHome()
      await acquired.lease.noteProviderProcess(1_002)
      const rotated = credential(2_000, `R1-${point}`)
      await privateFile(join(f.homeA, 'credentials', 'kimi-code.json'), rotated)

      await expect(acquired.lease.commitAndRelease()).rejects.toThrow(`injected crash at ${point}`)

      const restarted = authority({ pid: 1_003, instanceId: `after-${point}` })
      const next = await restarted.acquire(request(f, f.homeB))
      expect(next.ok).toBe(true)
      if (!next.ok) return
      expect(await fs.readFile(join(f.sourceHome, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
        rotated
      )
      await expect(fs.access(join(f.homeA, 'credentials'))).rejects.toThrow()
      await next.lease.seedIntoIsolatedHome()
      await expect(next.lease.commitAndRelease()).resolves.toBe('unchanged')
    },
    20_000
  )

  it('finishes forward when the isolated candidate is lost after the source commit', async () => {
    const f = await fixture()
    let injected = false
    const first = authority({
      pid: 1_051,
      instanceId: 'before-candidate-loss',
      identities: new Map([[1_052, 'child-before-candidate-loss']]),
      onTransition: (point) => {
        if (!injected && point === 'after-primary-commit') {
          injected = true
          throw new Error('injected crash after source commit')
        }
      }
    })
    const acquired = await first.acquire(request(f))
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    await acquired.lease.seedIntoIsolatedHome()
    await acquired.lease.noteProviderProcess(1_052)
    const rotated = credential(2_000, 'R1-candidate-lost')
    await privateFile(join(f.homeA, 'credentials', 'kimi-code.json'), rotated)

    await expect(acquired.lease.commitAndRelease()).rejects.toThrow(
      'injected crash after source commit'
    )
    expect(await fs.readFile(join(f.sourceHome, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      rotated
    )
    await fs.rm(join(f.homeA, 'credentials'), { recursive: true, force: true })

    // The fsynced pre-commit digest, not a surviving seat candidate, proves
    // that source primary already holds this lease's exact rotation.
    const restarted = authority({ pid: 1_053, instanceId: 'after-candidate-loss' })
    const next = await restarted.acquire(request(f, f.homeA))
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(await fs.readFile(join(f.sourceHome, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      rotated
    )
    await next.lease.seedIntoIsolatedHome()
    await expect(next.lease.commitAndRelease()).resolves.toBe('unchanged')
    await expect(
      fs.access(join(f.sourceHome, '.taskwraith-oauth-authority-v1', 'lease.json'))
    ).rejects.toThrow()
    expect(await fs.readFile(join(f.sourceHome, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      rotated
    )
  }, 20_000)

  // 20s budget: this real-fs crash-recovery flow (fixture home trees + many
  // small file ops, no timers to fake) blew the 5s default on a Windows CI
  // runner under 3-way job contention (2026-07-24 run 30081752978); it passes
  // in well under 1s uncontended.
  it('recovers a same-seat crash before prepareKimiIsolatedHome scrubs or reseeds it', async () => {
    const f = await fixture()
    await privateFile(
      join(f.sourceHome, 'config.toml'),
      'default_model = "kimi-code/kimi-for-coding"\n'
    )
    let currentAuthority = authority({
      pid: 1_101,
      instanceId: 'first-process',
      identities: new Map([[1_102, 'first-child']])
    })
    const homeFs: KimiHomeFs = {
      readFile: (path) => fs.readFile(path, 'utf8'),
      writeFile: (path, data, mode) => fs.writeFile(path, data, { encoding: 'utf8', mode }),
      mkdir: async (path) => {
        await fs.mkdir(path, { recursive: true, mode: 0o700 })
      },
      copyFile: (from, to) => fs.copyFile(from, to),
      chmod: (path, mode) => fs.chmod(path, mode),
      exists: async (path) => {
        try {
          await fs.access(path)
          return true
        } catch {
          return false
        }
      },
      rm: (path) => fs.rm(path, { recursive: true, force: true }),
      join: (...parts) => join(...parts),
      readdir: (path) => fs.readdir(path),
      lstat: (path) => fs.lstat(path),
      realpath: (path) => fs.realpath(path),
      acquireOAuthCredentialLease: (leaseRequest) => currentAuthority.acquire(leaseRequest)
    }

    const first = await prepareKimiIsolatedHome({
      runId: 'before-crash',
      homeDir: f.homeA,
      boundaryRoot: f.boundaryRoot,
      sourceHome: f.sourceHome,
      preserveSessionState: true,
      strictCleanup: true,
      fs: homeFs
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await first.noteProviderProcess(1_102)
    const rotated = credential(2_000, 'R1-same-seat')
    await privateFile(join(f.homeA, 'credentials', 'kimi-code.json'), rotated)

    // Simulate an app restart without invoking the old cleanup. The next
    // prepare targets the SAME durable home; recovery must read R1 before the
    // normal durable-home scrub can remove that candidate.
    currentAuthority = authority({ pid: 1_103, instanceId: 'restarted-process' })
    const restarted = await prepareKimiIsolatedHome({
      runId: 'after-crash',
      homeDir: f.homeA,
      boundaryRoot: f.boundaryRoot,
      sourceHome: f.sourceHome,
      preserveSessionState: true,
      strictCleanup: true,
      fs: homeFs
    })
    expect(restarted.ok).toBe(true)
    if (!restarted.ok) return
    expect(await fs.readFile(join(f.sourceHome, 'credentials', 'kimi-code.json'), 'utf8')).toBe(
      rotated
    )
    expect(await fs.readFile(join(f.homeA, 'credentials', 'kimi-code.json'), 'utf8')).toBe(rotated)
    await restarted.cleanup()
  }, 20_000)
})

describe('first-time setup: the user already signed in to the CLI', () => {
  const ARTEFACTS = ['credentials/kimi-code.json', 'oauth/kimi-code', 'device_id'] as const

  it.skipIf(process.platform === 'win32').each(ARTEFACTS)(
    'tightens a umask-022 %s instead of refusing the seat',
    async (relative) => {
      // The reported failure: a fresh `kimi` login writes its credentials 0644
      // under a default umask, and EVERY artefact was checked, so a loose
      // device_id alone was enough to fail a seat whose credential was fine.
      // Nothing repaired file modes, so re-logging-in reproduced it forever.
      const f = await fixture()
      const target = join(f.sourceHome, ...relative.split('/'))
      await fs.chmod(target, 0o644)

      const result = await authority({ pid: 501, instanceId: 'fresh' }).acquire(request(f))

      expect(result.ok).toBe(true)
      const tightened = await fs.stat(target)
      expect(tightened.mode & 0o077).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'still refuses a tree owned by another user, and points at sudo',
    async () => {
      // The sudo-once case. Not repairable and not ours to adopt — sudo creates
      // the whole tree as root, so the DIRECTORY check trips before any
      // artefact is opened, which is why the remedy lives on that error.
      const f = await fixture()
      const authorityUnderTest = new KimiOAuthCredentialAuthority({
        pid: 502,
        instanceId: 'foreign',
        isProcessAlive: () => false
      })
      const realGetuid = process.getuid
      // Claim to be a different uid than the fixture's owner.
      Object.defineProperty(process, 'getuid', { value: () => -12345, configurable: true })
      try {
        const result = await authorityUnderTest.acquire(request(f))
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.message).toContain('owned by uid')
        expect(result.message).toContain('sudo')
      } finally {
        Object.defineProperty(process, 'getuid', { value: realGetuid, configurable: true })
      }
    }
  )

  it('names the missing home rather than blaming the credential authority', async () => {
    const f = await fixture()
    await fs.rm(f.sourceHome, { recursive: true, force: true })

    const result = await authority({ pid: 503, instanceId: 'nohome' }).acquire(request(f))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Sign in with the Kimi CLI first')
  })

  it('surfaces the underlying reason instead of one opaque sentence', async () => {
    // Regression pin for the diagnosability defect itself: whatever the cause,
    // the message must carry more than the bare prefix it used to end at.
    const f = await fixture()
    await fs.rm(join(f.sourceHome, 'credentials', 'kimi-code.json'))
    await fs.mkdir(join(f.sourceHome, 'credentials', 'kimi-code.json'), { mode: 0o700 })

    const result = await authority({ pid: 504, instanceId: 'weird' }).acquire(request(f))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toBe(
      'TaskWraith could not establish the private Kimi OAuth credential authority. Managed OAuth execution was not started.'
    )
    expect(result.message).toContain('kimi-code.json')
  })
})
