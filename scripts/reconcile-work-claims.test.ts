import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { reconcile } = require('./reconcile-work-claims.cjs')
const { markerKind } = require('./work-claim-policy.cjs')
const { liveness } = require('./work-guard.cjs')
const roots: string[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_INDEX_FILE: undefined }
  }).trim()
}
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-reconcile-')))
  roots.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Marker tests')
  git(root, 'config', 'user.email', 'markers@example.invalid')
  fs.writeFileSync(path.join(root, 'source.txt'), 'original\n')
  git(root, 'add', '--', 'source.txt')
  git(root, 'commit', '-qm', 'fixture')
  const key = 'test-actor'
  const id = hash(key)
  const worktreeId = hash(root)
  const recordId = randomUUID()
  const directory = path.join(root, '.git', 'taskwraith', 'shared-workspace-v1', worktreeId, id)
  fs.mkdirSync(directory, { recursive: true })
  const record = path.join(directory, `${recordId}.prepared.json`)
  fs.writeFileSync(
    record,
    JSON.stringify({
      schemaVersion: 1,
      id: recordId,
      contributionId: id,
      actor: { key, lockOwnerId: 'owner' }
    })
  )
  const ref = `refs/taskwraith/contributions/${worktreeId}/${recordId}`
  git(root, 'update-ref', ref, 'HEAD')
  const file = `.WORK-IN-PROGRESS-taskwraith-contribution-${id}.md`
  const text = `---\nsession: ${id}\nagent: taskwraith-contribution\nlockOwnerId: owner\nstarted: 2020-01-01T00:00:00Z\nexpires: 2020-01-01T00:20:00Z\npaths:\n  - source.txt\n---\n`
  fs.writeFileSync(path.join(root, file), text)
  return { root, file, text, ref, record }
}

describe('recoverable contribution marker reconciliation', () => {
  it('reports by default, then archives only the expired projection and preserves staged work and recovery', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.root, 'source.txt'), 'peer staged\n')
    git(f.root, 'add', '--', 'source.txt')
    fs.writeFileSync(path.join(f.root, 'source.txt'), 'peer unstaged\n')
    const index = fs.readFileSync(path.join(f.root, '.git', 'index'))
    const record = fs.readFileSync(f.record)
    expect(reconcile(f.root).markers[0].action).toBe('eligible')
    expect(fs.readFileSync(path.join(f.root, f.file), 'utf8')).toBe(f.text)
    const row = reconcile(f.root, { apply: true }).markers[0]
    expect(row.action).toBe('archived')
    expect(fs.readFileSync(row.archive, 'utf8')).toBe(f.text)
    expect(fs.readFileSync(path.join(f.root, '.git', 'index'))).toEqual(index)
    expect(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8')).toBe('peer unstaged\n')
    expect(fs.readFileSync(f.record)).toEqual(record)
    expect(git(f.root, 'rev-parse', f.ref)).toBe(git(f.root, 'rev-parse', 'HEAD'))
    expect(reconcile(f.root, { apply: true }).markers).toEqual([])
  })
  it('preserves a claim if its recovery ref is absent', () => {
    const f = fixture()
    git(f.root, 'update-ref', '-d', f.ref)
    expect(reconcile(f.root, { apply: true }).markers[0]).toMatchObject({
      action: 'preserved',
      reason: 'Unsettled contribution is missing its recovery ref'
    })
    expect(fs.existsSync(path.join(f.root, f.file))).toBe(true)
  })
  it('preserves a renewal between inspection and retirement', () => {
    const f = fixture()
    const renewed = f.text.replaceAll('2020-01-01', '2099-01-01')
    const result = reconcile(f.root, {
      apply: true,
      beforeRetire: (file: string) => fs.writeFileSync(file, renewed)
    })
    expect(result.markers[0].action).toBe('preserved')
    expect(fs.readFileSync(path.join(f.root, f.file), 'utf8')).toBe(renewed)
  })
  it('preserves malformed runtime projections, manual claims, symlinks and current contribution leases', () => {
    const f = fixture()
    const runtime = '.WORK-IN-PROGRESS-taskwraith-runtime-malformed.md'
    const manual = '.WORK-IN-PROGRESS-human.md'
    fs.writeFileSync(path.join(f.root, runtime), 'truncated projection')
    fs.writeFileSync(path.join(f.root, manual), 'manual')
    fs.writeFileSync(path.join(f.root, f.file), f.text.replaceAll('2020-01-01', '2099-01-01'))
    expect(
      reconcile(f.root, { apply: true }).markers.every(
        (row: { action: string }) => row.action === 'preserved'
      )
    ).toBe(true)
    fs.unlinkSync(path.join(f.root, f.file))
    fs.symlinkSync(path.join(f.root, manual), path.join(f.root, f.file))
    expect(
      reconcile(f.root, { apply: true }).markers.every(
        (row: { action: string }) => row.action === 'preserved'
      )
    ).toBe(true)
    expect(markerKind(runtime, null)).toBe('runtime')
  })
  it("does not let another editor's heartbeat revive an expired contribution", () => {
    const now = Date.now()
    const marker = {
      file: '.WORK-IN-PROGRESS-old.md',
      agent: 'taskwraith-contribution',
      pid: null,
      expiresMs: now - 1000,
      started: new Date(now - 1200001).toISOString(),
      lockOwnerId: randomUUID()
    }
    expect(liveness(marker, { [marker.file]: { lastSeen: now } }, now).live).toBe(false)
    expect(
      liveness({ ...marker, agent: 'codex' }, { [marker.file]: { lastSeen: now } }, now).live
    ).toBe(true)
  })
})
