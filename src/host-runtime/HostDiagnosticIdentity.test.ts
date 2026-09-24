import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_DIAGNOSTIC_IDENTITY_FILENAME,
  loadOrCreateHostDiagnosticInstallIdentity
} from './HostDiagnosticIdentity'

const profiles: string[] = []

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-host-diagnostic-identity-'))
  profiles.push(path)
  return path
}

function identityPath(profilePath: string): string {
  return join(profilePath, HOST_DIAGNOSTIC_IDENTITY_FILENAME)
}

function temporaryIdentityFiles(profilePath: string): string[] {
  return readdirSync(profilePath).filter((name) => name.includes('.tmp'))
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('loadOrCreateHostDiagnosticInstallIdentity', () => {
  it('creates one opaque owner-only identity and reuses it without path derivation', () => {
    const profilePath = profile()
    const first = loadOrCreateHostDiagnosticInstallIdentity(profilePath, {
      createInstallId: () => 'a'.repeat(48)
    })
    const second = loadOrCreateHostDiagnosticInstallIdentity(profilePath, {
      createInstallId: () => 'b'.repeat(48)
    })

    expect(first).toEqual(second)
    expect(first.hostId).toBe(`taskwraith-diagnostic-${'a'.repeat(48)}`)
    expect(first.hostId).not.toContain(profilePath)
    expect(readFileSync(identityPath(profilePath), 'utf8')).toContain(
      '"installId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
    )
    if (process.platform !== 'win32') {
      expect(statSync(identityPath(profilePath)).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects noncanonical paths and unsafe existing identity files', () => {
    const profilePath = profile()
    expect(() => loadOrCreateHostDiagnosticInstallIdentity(`${profilePath}/..`)).toThrow(
      /canonical/
    )

    const linkedProfile = profile()
    const target = join(profile(), 'identity-target')
    symlinkSync(target, identityPath(linkedProfile))
    expect(() => loadOrCreateHostDiagnosticInstallIdentity(linkedProfile)).toThrow(/regular file/)

    const oversizedProfile = profile()
    writeFileSync(identityPath(oversizedProfile), 'x'.repeat(1025), { mode: 0o600 })
    expect(() => loadOrCreateHostDiagnosticInstallIdentity(oversizedProfile)).toThrow(/oversized/)
  })

  it('never publishes a torn final identity when writing or fsyncing the private temp file fails', () => {
    const partialProfile = profile()
    expect(() =>
      loadOrCreateHostDiagnosticInstallIdentity(partialProfile, {
        createInstallId: () => 'c'.repeat(48),
        writeTemp: (descriptor, bytes) => {
          writeSync(descriptor, bytes.slice(0, 12))
          throw new Error('partial write interrupted')
        }
      })
    ).toThrow(/partial write interrupted/)
    expect(existsSync(identityPath(partialProfile))).toBe(false)
    expect(temporaryIdentityFiles(partialProfile)).toEqual([])

    const fsyncProfile = profile()
    expect(() =>
      loadOrCreateHostDiagnosticInstallIdentity(fsyncProfile, {
        createInstallId: () => 'd'.repeat(48),
        syncTemp: () => {
          throw new Error('temp fsync interrupted')
        }
      })
    ).toThrow(/temp fsync interrupted/)
    expect(existsSync(identityPath(fsyncProfile))).toBe(false)
    expect(temporaryIdentityFiles(fsyncProfile)).toEqual([])
  })

  it('reads a fully validated winner when atomic publication loses its no-replace race', () => {
    const profilePath = profile()
    const winnerId = 'e'.repeat(48)
    const winnerRecord = {
      schemaVersion: 1,
      purpose: 'taskwraith:diagnostic-install:v1',
      installId: winnerId
    }
    const race = Object.assign(new Error('winner already published'), { code: 'EEXIST' })

    const identity = loadOrCreateHostDiagnosticInstallIdentity(profilePath, {
      createInstallId: () => 'f'.repeat(48),
      publish: (_tempPath, finalPath) => {
        writeFileSync(finalPath, `${JSON.stringify(winnerRecord)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx'
        })
        throw race
      }
    })

    expect(identity.installId).toBe(winnerId)
    expect(readFileSync(identityPath(profilePath), 'utf8')).toBe(
      `${JSON.stringify(winnerRecord)}\n`
    )
    expect(temporaryIdentityFiles(profilePath)).toEqual([])
  })
})
