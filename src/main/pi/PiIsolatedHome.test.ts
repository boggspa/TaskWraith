import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createPiIsolatedHome,
  verifyPiIsolatedHome,
  type PiIsolatedHomeLease
} from './PiIsolatedHome'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'taskwraith-pi-isolated-home-test-'))
const leases: PiIsolatedHomeLease[] = []

afterAll(() => {
  for (const lease of leases) lease.cleanup()
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

function create(runId = 'run-1'): PiIsolatedHomeLease {
  const lease = createPiIsolatedHome({ temporaryRoot: TEMP_ROOT, runId })
  leases.push(lease)
  return lease
}

describe('Pi isolated home', () => {
  it('uses collision-resistant mkdtemp paths and returns a verified real-directory lease', () => {
    const first = create('same-run')
    const second = create('same-run')

    expect(first.path).not.toBe(second.path)
    expect(first.path).toMatch(/taskwraith-pi-home-[a-f0-9]{16}-[^/]+$/)
    expect(lstatSync(first.path).isDirectory()).toBe(true)
    expect(lstatSync(first.path).isSymbolicLink()).toBe(false)
    expect(verifyPiIsolatedHome(first)).toEqual(first.authority)
    expect(first.authority).toMatchObject({
      schemaVersion: 1,
      strategy: 'node-mkdtemp-random-suffix-v1',
      canonicalRealPathVerified: true,
      leafType: 'real-directory',
      cleanupPolicy: 'identity-match-recursive-force'
    })

    if (process.platform === 'win32') {
      expect(first.authority).toMatchObject({
        ownerVerification: 'unsupported-platform',
        modeVerification: 'unsupported-platform',
        fileIdentityVerification: 'device-inode-best-effort'
      })
    } else {
      const info = lstatSync(first.path)
      expect(info.mode & 0o777).toBe(0o700)
      expect(first.authority).toMatchObject({
        ownerVerification: 'process-uid-match',
        modeVerification: 'posix-0700',
        fileIdentityVerification: 'device-inode-match'
      })
    }
  })

  it('refuses a mode-weakened directory where POSIX mode semantics are available', () => {
    if (process.platform === 'win32') return
    const lease = create('mode-change')
    chmodSync(lease.path, 0o755)
    expect(() => verifyPiIsolatedHome(lease)).toThrow(/0700/i)
    const cleanup = lease.cleanup()
    expect(cleanup.ok).toBe(false)
    chmodSync(lease.path, 0o700)
    expect(lease.cleanup()).toEqual({ ok: true, alreadyAbsent: false })
  })

  it('refuses to attest or recursively remove an identity-swapped directory', () => {
    const lease = create('identity-swap')
    const path = lease.path
    // The swap has to land on a DIFFERENT inode or there is nothing for a
    // device+inode check to notice. Removing the directory and recreating it in
    // place does not guarantee that: Linux filesystems routinely hand the
    // just-freed inode straight back, so the "replacement" was byte-for-byte
    // the same identity and the expected throw never came — green on APFS,
    // red on the Linux runner. Allocating the replacement while the original
    // still exists forces a distinct inode, then rename swaps it in.
    const replacement = join(TEMP_ROOT, 'identity-swap-replacement')
    mkdirSync(replacement, { mode: 0o700 })
    rmSync(path, { recursive: true, force: true })
    renameSync(replacement, path)

    expect(() => verifyPiIsolatedHome(lease)).toThrow(/identity/i)
    expect(lease.cleanup()).toMatchObject({ ok: false })
    expect(lstatSync(path).isDirectory()).toBe(true)
    rmSync(path, { recursive: true, force: true })
  })

  it.runIf(process.platform !== 'win32')(
    'refuses a symlink replacement and leaves its target untouched',
    () => {
      const lease = create('symlink-swap')
      const path = lease.path
      const target = join(TEMP_ROOT, 'symlink-target')
      mkdirSync(target, { mode: 0o700 })
      rmSync(path, { recursive: true, force: true })
      symlinkSync(target, path)

      expect(() => verifyPiIsolatedHome(lease)).toThrow(/canonical real path|real directory/i)
      expect(lease.cleanup()).toMatchObject({ ok: false })
      expect(lstatSync(path).isSymbolicLink()).toBe(true)
      expect(lstatSync(target).isDirectory()).toBe(true)
      rmSync(path, { force: true })
      rmSync(target, { recursive: true, force: true })
    }
  )

  it('cleans only the issued identity and is idempotent after success', () => {
    const lease = create('cleanup')
    expect(lease.cleanup()).toEqual({ ok: true, alreadyAbsent: false })
    expect(lease.cleanup()).toEqual({ ok: true, alreadyAbsent: true })
    expect(() => verifyPiIsolatedHome(lease)).toThrow(/already been cleaned/i)
  })

  it('rejects forged lease-shaped objects', () => {
    const issued = create('forgery-source')
    const forged = {
      path: issued.path,
      authority: issued.authority,
      verify: () => issued.authority,
      cleanup: () => ({ ok: true as const, alreadyAbsent: false })
    }
    expect(() => verifyPiIsolatedHome(forged)).toThrow(/main-issued/i)
  })
})
