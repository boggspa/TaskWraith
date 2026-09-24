import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import {
  HOST_SERVER_IDENTITY_FILENAME,
  HOST_SERVER_PRODUCTION_VERSION,
  loadOrCreateHostServerIdentity
} from './HostServerIdentity'

const paths: string[] = []
afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

it('creates once after authority, preserves a valid existing hostId, and rejects unsafe identity artifacts', () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'host-server-id-')))
  paths.push(profile)
  let assertions = 0
  const authority = {
    assertHeld: () => {
      assertions++
    }
  }
  const first = loadOrCreateHostServerIdentity({
    profilePath: profile,
    authority,
    createHostId: () => 'desktop-host-id'
  })
  expect(first).toEqual({ hostId: 'desktop-host-id', hostVersion: HOST_SERVER_PRODUCTION_VERSION })
  expect(
    loadOrCreateHostServerIdentity({
      profilePath: profile,
      authority,
      createHostId: () => 'different'
    }).hostId
  ).toBe('desktop-host-id')
  expect(assertions).toBeGreaterThanOrEqual(2)
  const path = join(profile, 'host-runtime', HOST_SERVER_IDENTITY_FILENAME)
  expect(JSON.parse(readFileSync(path, 'utf8')).hostId).toBe('desktop-host-id')
  // @portability-ok: octal modes are POSIX-only — NTFS reports fixed modes and owner-only is ACL-enforced
  if (process.platform !== 'win32') {
    chmodSync(path, 0o644)
    expect(() => loadOrCreateHostServerIdentity({ profilePath: profile, authority })).toThrow(
      'Unsafe'
    )
  }
})

it('fails closed on a symlink identity and only creates after authority proof', () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'host-server-id-link-')))
  paths.push(profile)
  const runtime = join(profile, 'host-runtime')
  mkdirSync(runtime, { mode: 0o700 })
  const target = join(profile, 'target.json')
  writeFileSync(
    target,
    JSON.stringify({ schemaVersion: 1, hostId: 'foreign', createdAt: new Date().toISOString() })
  )
  chmodSync(target, 0o600)
  symlinkSync(target, join(runtime, HOST_SERVER_IDENTITY_FILENAME))
  expect(() =>
    loadOrCreateHostServerIdentity({ profilePath: profile, authority: { assertHeld: () => {} } })
  ).toThrow('Unsafe')
  expect(() =>
    loadOrCreateHostServerIdentity({
      profilePath: profile,
      authority: {
        assertHeld: () => {
          throw new Error('lease lost')
        }
      }
    })
  ).toThrow('lease lost')
})

it('rejects a runtime-dir symlink and malformed creation clock before publication', () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'host-server-id-runtime-link-')))
  paths.push(profile)
  const target = mkdtempSync(join(tmpdir(), 'host-server-id-target-'))
  paths.push(target)
  symlinkSync(target, join(profile, 'host-runtime'))
  expect(() =>
    loadOrCreateHostServerIdentity({ profilePath: profile, authority: { assertHeld: () => {} } })
  ).toThrow('Unsafe Host runtime directory')

  const clean = realpathSync(mkdtempSync(join(tmpdir(), 'host-server-id-clock-')))
  paths.push(clean)
  expect(() =>
    loadOrCreateHostServerIdentity({
      profilePath: clean,
      authority: { assertHeld: () => {} },
      now: () => 'not-an-iso'
    })
  ).toThrow('timestamp')
})
