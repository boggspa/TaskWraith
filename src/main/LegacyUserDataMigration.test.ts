import * as fs from 'node:fs'
import * as os from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { migrateLegacyUserDataSync } from './LegacyUserDataMigration'

function writeProfile(path: string, name: string): void {
  fs.mkdirSync(join(path, 'chats'), { recursive: true })
  fs.writeFileSync(join(path, 'settings.json'), JSON.stringify({ name }), 'utf8')
  fs.writeFileSync(join(path, 'chats', 'chat.json'), JSON.stringify({ name }), 'utf8')
}

function snapshotTree(root: string): Record<string, { bytes?: string; mtimeMs: number }> {
  const snapshot: Record<string, { bytes?: string; mtimeMs: number }> = {}
  const visit = (currentPath: string): void => {
    const stat = fs.statSync(currentPath)
    const relativePath = currentPath.slice(root.length) || '.'
    snapshot[relativePath] = {
      ...(stat.isFile() ? { bytes: fs.readFileSync(currentPath).toString('base64') } : {}),
      mtimeMs: stat.mtimeMs
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(currentPath).sort()) visit(join(currentPath, child))
    }
  }
  visit(root)
  return snapshot
}

describe('migrateLegacyUserDataSync', () => {
  let parent: string
  let profile: string

  beforeEach(() => {
    parent = fs.mkdtempSync(join(os.tmpdir(), 'legacy-userdata-migration-'))
    profile = join(parent, 'TaskWraith')
  })

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true })
  })

  it('copies the packaged AGBench profile without overwriting fresh-profile files', () => {
    const packaged = join(parent, 'AGBench')
    writeProfile(packaged, 'packaged')
    fs.writeFileSync(join(packaged, 'preserved.txt'), 'legacy', 'utf8')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(join(profile, 'preserved.txt'), 'current', 'utf8')
    const log = { log: vi.fn(), warn: vi.fn() }

    const result = migrateLegacyUserDataSync({
      userDataPath: profile,
      now: () => new Date('2026-08-24T08:50:00.000Z'),
      log
    })

    expect(result).toEqual({ state: 'copied', sourceName: 'AGBench' })
    expect(fs.readFileSync(join(profile, 'settings.json'), 'utf8')).toContain('packaged')
    expect(fs.readFileSync(join(profile, 'preserved.txt'), 'utf8')).toBe('current')
    expect(fs.readFileSync(join(profile, '.taskwraith-userdata-migration'), 'utf8')).toBe(
      'checked 2026-08-24T08:50:00.000Z\n'
    )
    expect(log.log).toHaveBeenCalledTimes(1)
  })

  it('skips an already-established profile while still recording the one-time check', () => {
    writeProfile(profile, 'current')
    writeProfile(join(parent, 'AGBench'), 'legacy')

    const result = migrateLegacyUserDataSync({ userDataPath: profile })

    expect(result).toEqual({ state: 'existing_profile' })
    expect(fs.readFileSync(join(profile, 'settings.json'), 'utf8')).toContain('current')
    expect(fs.existsSync(join(profile, '.taskwraith-userdata-migration'))).toBe(true)
  })

  it('filters volatile Chromium state and socket files from a legacy copy', () => {
    const legacy = join(parent, 'AGBench')
    writeProfile(legacy, 'legacy')
    fs.mkdirSync(join(legacy, 'Cache'), { recursive: true })
    fs.writeFileSync(join(legacy, 'Cache', 'cache-entry'), 'volatile', 'utf8')
    fs.writeFileSync(join(legacy, 'agent.sock'), 'socket', 'utf8')
    fs.mkdirSync(join(legacy, 'nested'), { recursive: true })
    fs.writeFileSync(join(legacy, 'nested', 'worker.sock'), 'socket', 'utf8')
    fs.writeFileSync(join(legacy, 'nested', 'kept.txt'), 'durable', 'utf8')

    expect(migrateLegacyUserDataSync({ userDataPath: profile }).state).toBe('copied')
    expect(fs.existsSync(join(profile, 'Cache'))).toBe(false)
    expect(fs.existsSync(join(profile, 'agent.sock'))).toBe(false)
    expect(fs.existsSync(join(profile, 'nested', 'worker.sock'))).toBe(false)
    expect(fs.readFileSync(join(profile, 'nested', 'kept.txt'), 'utf8')).toBe('durable')
  })

  it('is idempotent once the marker has been recorded', () => {
    const legacy = join(parent, 'AGBench')
    writeProfile(legacy, 'first')
    expect(migrateLegacyUserDataSync({ userDataPath: profile }).state).toBe('copied')
    fs.writeFileSync(join(legacy, 'after-first-run.txt'), 'later', 'utf8')

    expect(migrateLegacyUserDataSync({ userDataPath: profile })).toEqual({
      state: 'already_checked'
    })
    expect(fs.existsSync(join(profile, 'after-first-run.txt'))).toBe(false)
  })

  it('rejects non-canonical and root targets before any recursive filesystem operation', () => {
    const before = snapshotTree(parent)
    const log = { log: vi.fn(), warn: vi.fn() }

    expect(migrateLegacyUserDataSync({ userDataPath: `${profile}/..`, log })).toEqual({
      state: 'invalid_profile'
    })
    expect(migrateLegacyUserDataSync({ userDataPath: parse(profile).root, log })).toEqual({
      state: 'invalid_profile'
    })
    expect(snapshotTree(parent)).toEqual(before)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })
})
