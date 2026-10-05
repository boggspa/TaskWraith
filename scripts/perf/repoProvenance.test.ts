import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { collectRepoProvenance, detectIsolatedWorktree, liesInsideAnotherCheckout } =
  require('./repoProvenance.cjs') as {
    collectRepoProvenance: (options: { repoRoot: string; forceIsolated?: boolean }) => {
      gitSha: string
      dirty: boolean
      dirtyPaths: string[]
      isolatedWorktree: boolean
      authoritativeBaseline: boolean
    }
    detectIsolatedWorktree: (repoRoot: string) => boolean
    liesInsideAnotherCheckout: (
      repoRoot: string,
      options?: { realpath?: (target: string) => string }
    ) => boolean
  }
const { runT2BaselineCli } = require('./runT2Baseline.cjs') as {
  runT2BaselineCli: (argv: string[], options: Record<string, unknown>) => Promise<unknown>
}

/** Every directory this file makes is named so, directly in the temporary folder. */
const MADE_PREFIX = 'harness-provenance-'
const made: string[] = []

/** A fresh directory of this file's own, removed after the test. */
function makeDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), MADE_PREFIX))
  made.push(dir)
  return dir
}

/** Removes a directory only when it is one this file made: never the folder above it. */
function removeMade(dir: string) {
  const root = tmpdir()
  if (dir === root || path.resolve(dir) !== dir || !dir.startsWith(root + path.sep + MADE_PREFIX)) {
    throw new Error(`refusing to remove ${dir}: not a directory this file made`)
  }
  rmSync(dir, { recursive: true, force: true })
}

afterEach(() => {
  while (made.length > 0) removeMade(made.pop()!)
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
  const root = makeDirectory()
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

/**
 * A linked worktree of root with a commit of its own and nothing changed,
 * made inside a directory of this file's own for git to create it in.
 */
function linkedWorktree(root: string) {
  const linked = path.join(makeDirectory(), 'tree')
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
    const alias = path.join(makeDirectory(), 'tree')
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

describe('which checkouts count as isolated', () => {
  it('a linked worktree, by git’s own word, and not the checkout it was made from', () => {
    const { root } = checkoutWithExport()
    const { linked } = linkedWorktree(root)
    expect(detectIsolatedWorktree(linked)).toBe(true)
    expect(detectIsolatedWorktree(root)).toBe(false)
  })

  // A guess from the path, kept as it was and pinned: see detectIsolatedWorktree.
  it('also a checkout of its own whose path runs through a worktrees folder, and no other', () => {
    const base = makeDirectory()
    const checkouts = {
      worktrees: path.join(base, 'worktrees', 'clone'),
      taskwraith: path.join(base, '.taskwraith-worktrees', 'repo', 'clone'),
      plain: path.join(base, 'plain', 'clone'),
      named: path.join(base, 'my-worktrees', 'clone')
    }
    for (const dir of Object.values(checkouts)) {
      mkdirSync(dir, { recursive: true })
      git(dir, 'init', '--quiet')
    }
    expect(detectIsolatedWorktree(checkouts.worktrees)).toBe(true)
    expect(detectIsolatedWorktree(checkouts.taskwraith)).toBe(true)
    expect(detectIsolatedWorktree(checkouts.plain)).toBe(false)
    expect(detectIsolatedWorktree(checkouts.named)).toBe(false)
  })
})

describe('whether a tree lies inside a checkout that is not its own', () => {
  it('is false at a checkout’s root and outside any checkout, and true inside one', () => {
    const { root, exportRoot } = checkoutWithExport()
    expect(liesInsideAnotherCheckout(root)).toBe(false)
    expect(liesInsideAnotherCheckout(exportRoot)).toBe(true)
    expect(liesInsideAnotherCheckout(makeDirectory())).toBe(false)
  })

  it('is true when a root cannot be resolved, so nothing is taken for the tree’s own', () => {
    const { root } = checkoutWithExport()
    const asked: string[] = []
    const failing = (target: string): string => {
      asked.push(target)
      throw new Error(`cannot resolve ${target}`)
    }
    expect(liesInsideAnotherCheckout(root, { realpath: failing })).toBe(true)
    expect(asked).toHaveLength(1)
  })
})
