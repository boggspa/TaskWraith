import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { collectRepoProvenance } = require('./repoProvenance.cjs') as {
  collectRepoProvenance: (options: { repoRoot: string; forceIsolated?: boolean }) => {
    gitSha: string
    dirty: boolean
    dirtyPaths: string[]
    isolatedWorktree: boolean
    authoritativeBaseline: boolean
  }
}
const { runT2BaselineCli } = require('./runT2Baseline.cjs') as {
  runT2BaselineCli: (argv: string[], options: Record<string, unknown>) => Promise<unknown>
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=perf test',
      '-c',
      'user.email=perf-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).trim()
}

/**
 * A checkout with one commit, a change left in it, and an ignored folder
 * holding a frozen export: a tree of files with no git of its own.
 */
function checkoutWithExport() {
  const root = mkdtempSync(path.join(tmpdir(), 'tw-provenance-'))
  made.push(root)
  git(root, 'init', '--quiet')
  writeFileSync(path.join(root, '.gitignore'), 'frozen/\n')
  writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}\n')
  git(root, 'add', '.gitignore', 'package.json')
  git(root, 'commit', '--quiet', '-m', 'one commit')
  writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.1"}\n')
  const exportRoot = path.join(root, 'frozen', 'source')
  mkdirSync(exportRoot, { recursive: true })
  writeFileSync(path.join(exportRoot, 'package.json'), '{"version":"0.9.0"}\n')
  return { root, exportRoot, head: git(root, 'rev-parse', 'HEAD') }
}

/** A linked worktree of root with a commit of its own and nothing changed. */
function linkedWorktree(root: string) {
  const linked = mkdtempSync(path.join(tmpdir(), 'tw-provenance-linked-'))
  made.push(linked)
  rmSync(linked, { recursive: true })
  git(root, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD')
  writeFileSync(path.join(linked, 'later.txt'), 'later\n')
  git(linked, 'add', 'later.txt')
  git(linked, 'commit', '--quiet', '-m', 'a commit of the worktree')
  return { linked, head: git(linked, 'rev-parse', 'HEAD') }
}

describe('repo provenance', () => {
  it('names the commit and the changes of the checkout whose root it is given', () => {
    const { root, head } = checkoutWithExport()
    const provenance = collectRepoProvenance({ repoRoot: root, forceIsolated: false })
    expect(provenance).toMatchObject({
      gitSha: head,
      dirty: true,
      dirtyPaths: ['package.json'],
      authoritativeBaseline: false
    })
  })

  it('names neither the commit nor the changes of a checkout it lies inside without being its root', () => {
    const { exportRoot, head } = checkoutWithExport()
    const provenance = collectRepoProvenance({ repoRoot: exportRoot })
    expect(provenance).toMatchObject({
      gitSha: 'unknown',
      // Nothing can say the tree is clean, so it is not taken to be.
      dirty: true,
      dirtyPaths: ['__not_a_git_checkout__'],
      isolatedWorktree: false,
      authoritativeBaseline: false
    })
    expect(JSON.stringify(provenance)).not.toContain(head)
    expect(provenance.dirtyPaths).not.toContain('package.json')
  })

  it('never takes a tree in a clean linked worktree for that worktree, nor for a baseline', () => {
    const { root } = checkoutWithExport()
    const { linked, head } = linkedWorktree(root)
    const exportRoot = path.join(linked, 'frozen', 'source')
    mkdirSync(exportRoot, { recursive: true })
    writeFileSync(path.join(exportRoot, 'package.json'), '{"version":"0.9.0"}\n')
    const provenance = collectRepoProvenance({ repoRoot: exportRoot })
    expect(provenance).toMatchObject({
      gitSha: 'unknown',
      dirty: true,
      dirtyPaths: ['__not_a_git_checkout__'],
      isolatedWorktree: false,
      authoritativeBaseline: false
    })
    expect(JSON.stringify(provenance)).not.toContain(head)
  })

  it('names a linked worktree by its own commit, through a path with a link in it', () => {
    const { root } = checkoutWithExport()
    const { linked, head } = linkedWorktree(root)
    const alias = path.join(mkdtempSync(path.join(tmpdir(), 'tw-provenance-alias-')), 'tree')
    made.push(path.dirname(alias))
    symlinkSync(linked, alias)
    const provenance = collectRepoProvenance({ repoRoot: alias })
    expect(provenance).toMatchObject({
      gitSha: head,
      dirty: false,
      dirtyPaths: [],
      isolatedWorktree: true,
      authoritativeBaseline: true
    })
  })

  it('makes the runner refuse to launch such a tree until someone vouches for it, and says why', async () => {
    const { exportRoot } = checkoutWithExport()
    const provenance = collectRepoProvenance({ repoRoot: exportRoot })
    await expect(
      runT2BaselineCli(['--workload=dual_run', '--launch', '--i-accept-isolated-launch'], {
        repoRoot: exportRoot,
        provenance,
        allowNonIsolatedLaunch: true
      })
    ).rejects.toThrow(
      `Refusing launch: ${exportRoot} is not the root of a git checkout, so git cannot say it is clean`
    )
  })
})
