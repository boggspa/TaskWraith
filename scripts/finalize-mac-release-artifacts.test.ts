import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  finalizeMacReleaseArtifacts
}: {
  finalizeMacReleaseArtifacts: (options: {
    distDir: string
    version: string
    appleId?: string
    applePassword?: string
    teamId?: string
    keychainProfile?: string
    notarize?: boolean
    run?: (command: string, args: string[], label: string) => void
    retryWait?: (milliseconds: number) => void
  }) => {
    metadata: { dmg: { sha512: string; size: number } }
    removedBlockmaps: string[]
  }
} = require('./finalize-mac-release-artifacts.cjs')
const {
  validateMacUpdateFeedFile
}: {
  validateMacUpdateFeedFile: (
    feedPath: string,
    version: string
  ) => { ok: boolean; errors: string[] }
} = require('./validate-mac-update-feed.cjs')

describe('macOS release artifact finalization', () => {
  it('notarizes then staples the exact DMG, removes its stale blockmap, and refreshes feed metadata', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-finalize-'))
    const version = '1.9.2'
    const dmg = path.join(distDir, `TaskWraith-${version}-universal-mac.dmg`)
    const zip = path.join(distDir, `TaskWraith-${version}-universal-mac.zip`)
    const zipBlockmap = `${zip}.blockmap`
    const dmgBlockmap = `${dmg}.blockmap`
    const feed = path.join(distDir, 'latest-mac.yml')
    fs.writeFileSync(dmg, 'pre-staple-dmg')
    const preStapleDmgSha512 = crypto
      .createHash('sha512')
      .update(fs.readFileSync(dmg))
      .digest('base64')
    fs.writeFileSync(zip, 'zip')
    fs.writeFileSync(zipBlockmap, 'zip blockmap')
    fs.writeFileSync(dmgBlockmap, 'stale dmg blockmap')
    fs.writeFileSync(
      feed,
      `version: ${version}\npath: ${path.basename(zip)}\nsha512: stale\nreleaseDate: '2026-07-29T00:00:00.000Z'\n`
    )
    const calls: Array<{ command: string; args: string[]; label: string }> = []

    try {
      const result = finalizeMacReleaseArtifacts({
        distDir,
        version,
        appleId: 'release@example.test',
        applePassword: 'app-password',
        teamId: 'TEAM123',
        keychainProfile: 'must-not-be-selected',
        run: (command, args, label) => {
          calls.push({ command, args, label })
          if (args[0] === 'stapler' && args[1] === 'staple') {
            fs.appendFileSync(dmg, '-stapled')
          }
        }
      })

      expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
        ['notarytool', 'submit'],
        ['stapler', 'staple'],
        ['stapler', 'validate']
      ])
      expect(calls[0].args).toEqual([
        'notarytool',
        'submit',
        dmg,
        '--apple-id',
        'release@example.test',
        '--password',
        'app-password',
        '--team-id',
        'TEAM123',
        '--wait'
      ])
      expect(fs.existsSync(dmgBlockmap)).toBe(false)
      expect(fs.existsSync(zipBlockmap)).toBe(true)
      expect(result.metadata.dmg.size).toBe(fs.statSync(dmg).size)
      expect(result.metadata.dmg.sha512).not.toBe(preStapleDmgSha512)
      expect(validateMacUpdateFeedFile(feed, version)).toMatchObject({ ok: true })
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true })
    }
  })

  it('uses an explicitly provisioned keychain profile when Apple ID credentials are absent', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-finalize-'))
    const version = '1.9.2'
    for (const name of [
      `TaskWraith-${version}-universal-mac.dmg`,
      `TaskWraith-${version}-universal-mac.zip`,
      `TaskWraith-${version}-universal-mac.zip.blockmap`,
      'latest-mac.yml'
    ]) {
      fs.writeFileSync(path.join(distDir, name), 'artifact')
    }
    const calls: string[][] = []
    try {
      finalizeMacReleaseArtifacts({
        distDir,
        version,
        keychainProfile: 'taskwraith-notary',
        run: (_command, args) => calls.push(args)
      })
      expect(calls[0]).toContain('--keychain-profile')
      expect(calls[0]).toContain('taskwraith-notary')
      expect(calls[0]).not.toContain('--apple-id')
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true })
    }
  })

  it('retries transient staple failures with bounded backoff, then validates once', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-finalize-'))
    const version = '1.9.2'
    for (const name of [
      `TaskWraith-${version}-universal-mac.dmg`,
      `TaskWraith-${version}-universal-mac.zip`,
      `TaskWraith-${version}-universal-mac.zip.blockmap`,
      'latest-mac.yml'
    ]) {
      fs.writeFileSync(path.join(distDir, name), 'artifact')
    }
    let stapleAttempts = 0
    let validateAttempts = 0
    const waits: number[] = []
    try {
      finalizeMacReleaseArtifacts({
        distDir,
        version,
        keychainProfile: 'taskwraith-notary',
        retryWait: (milliseconds) => waits.push(milliseconds),
        run: (_command, args) => {
          if (args[0] === 'stapler' && args[1] === 'staple') {
            stapleAttempts += 1
            if (stapleAttempts < 3) throw new Error('ticket not propagated yet')
          }
          if (args[0] === 'stapler' && args[1] === 'validate') {
            validateAttempts += 1
          }
        }
      })
      expect(stapleAttempts).toBe(3)
      expect(validateAttempts).toBe(1)
      expect(waits).toEqual([1000, 2000])
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true })
    }
  })

  it('fails closed after exhausting all exact-DMG staple attempts', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-finalize-'))
    const version = '1.9.2'
    const dmgBlockmap = path.join(distDir, `TaskWraith-${version}-universal-mac.dmg.blockmap`)
    for (const name of [
      `TaskWraith-${version}-universal-mac.dmg`,
      `TaskWraith-${version}-universal-mac.zip`,
      `TaskWraith-${version}-universal-mac.zip.blockmap`,
      'latest-mac.yml',
      path.basename(dmgBlockmap)
    ]) {
      fs.writeFileSync(path.join(distDir, name), 'artifact')
    }
    let stapleAttempts = 0
    let validateAttempts = 0
    try {
      expect(() =>
        finalizeMacReleaseArtifacts({
          distDir,
          version,
          keychainProfile: 'taskwraith-notary',
          retryWait: () => {},
          run: (_command, args) => {
            if (args[0] === 'stapler' && args[1] === 'staple') {
              stapleAttempts += 1
              throw new Error('ticket unavailable')
            }
            if (args[0] === 'stapler' && args[1] === 'validate') {
              validateAttempts += 1
            }
          }
        })
      ).toThrow('ticket unavailable')
      expect(stapleAttempts).toBe(4)
      expect(validateAttempts).toBe(0)
      expect(fs.existsSync(dmgBlockmap)).toBe(true)
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true })
    }
  })

  it('fails before mutation when notarization credentials are missing', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-finalize-'))
    const version = '1.9.2'
    for (const name of [
      `TaskWraith-${version}-universal-mac.dmg`,
      `TaskWraith-${version}-universal-mac.zip`,
      `TaskWraith-${version}-universal-mac.zip.blockmap`,
      'latest-mac.yml'
    ]) {
      fs.writeFileSync(path.join(distDir, name), 'artifact')
    }
    try {
      const blockmap = path.join(distDir, `TaskWraith-${version}-universal-mac.dmg.blockmap`)
      fs.writeFileSync(blockmap, 'stale')
      expect(() =>
        finalizeMacReleaseArtifacts({
          distDir,
          version,
          appleId: 'release@example.test',
          applePassword: '',
          teamId: 'TEAM123'
        })
      ).toThrow('complete APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID')
      expect(fs.existsSync(blockmap)).toBe(true)
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true })
    }
  })
})
