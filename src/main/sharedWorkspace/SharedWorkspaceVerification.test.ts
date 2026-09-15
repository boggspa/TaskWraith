import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import {
  beginSharedWorkspaceVerification,
  latestSharedWorkspaceVerification
} from './SharedWorkspaceVerification'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-shared-check-')))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'master')
  git('config', 'user.name', 'Check test')
  git('config', 'user.email', 'check@example.invalid')
  fs.writeFileSync(path.join(root, 'input.txt'), 'one\n')
  git('add', '--', 'input.txt')
  git('commit', '-qm', 'initial')
  return root
}

describe('shared workspace check freshness', () => {
  it('records successful observed inputs and invalidates them after a peer edit', async () => {
    const root = fixture()
    const check = await beginSharedWorkspaceVerification(root, ['npm', 'test'])
    expect(check).not.toBeNull()
    const receipt = await check!.finish({ exitCode: 0 })
    expect(receipt).toMatchObject({
      state: 'passed',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect((await latestSharedWorkspaceVerification(root))?.state).toBe('passed')
    fs.appendFileSync(path.join(root, 'input.txt'), 'peer\n')
    expect((await latestSharedWorkspaceVerification(root))?.state).toBe('changed')
  })

  it('marks a passing command provisional when inputs change during execution', async () => {
    const root = fixture()
    const check = await beginSharedWorkspaceVerification(root, ['npm', 'test'])
    fs.writeFileSync(path.join(root, 'input.txt'), 'two\n')
    expect((await check!.finish({ exitCode: 0 }))?.state).toBe('changed')
  })

  it('observes a tracked file changing and changing back between the two snapshots', async () => {
    const root = fixture()
    const check = await beginSharedWorkspaceVerification(root, ['npm', 'test'])
    // The content round-trips, so only the change observation can say
    // "changed". A fixed 30 ms let a late FSEvents delivery on a loaded runner
    // read as `passed` (macOS Apple Silicon, run 34969646465); wait for the
    // kernel to deliver the edit to a sentinel watcher registered alongside
    // the observation, then give the observation's own callback a turn.
    const delivered = new Promise<void>((resolve) => {
      const sentinel = fs.watch(root, { recursive: true }, () => {
        sentinel.close()
        resolve()
      })
      setTimeout(() => {
        sentinel.close()
        resolve()
      }, 5_000).unref()
    })
    fs.writeFileSync(path.join(root, 'input.txt'), 'temporary\n')
    fs.writeFileSync(path.join(root, 'input.txt'), 'one\n')
    await delivered
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await check!.finish({ exitCode: 0 }))?.state).toBe('changed')
  })

  it('retains an actual command failure instead of presenting a green input fingerprint', async () => {
    const root = fixture()
    const check = await beginSharedWorkspaceVerification(root, ['npm', 'test'])
    expect((await check!.finish({ exitCode: 1 }))?.state).toBe('failed')
    expect((await latestSharedWorkspaceVerification(root))?.state).toBe('failed')
  })

  it('keeps checks usable when there is no Git repository', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-shared-check-nogit-'))
    roots.push(root)
    expect(await beginSharedWorkspaceVerification(root, ['npm', 'test'])).toBeNull()
  })
})
