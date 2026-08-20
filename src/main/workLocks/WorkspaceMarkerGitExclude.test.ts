import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  RUNTIME_MARKER_EXCLUDE_PATTERN,
  ensureRuntimeMarkerExcluded,
  resolveGitCommonDirectory
} from './WorkspaceMarkerGitExclude'

const created: string[] = []

function scratch(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `taskwraith-marker-exclude-${label}-`))
  created.push(root)
  return root
}

/** A hand-built `.git` directory: enough for resolution without needing git. */
function plainRepo(label: string): string {
  const root = scratch(label)
  mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

function excludeText(commonDirectory: string): string {
  return readFileSync(join(commonDirectory, 'info', 'exclude'), 'utf8')
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  while (created.length > 0) {
    const root = created.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('resolveGitCommonDirectory', () => {
  it('returns the .git directory of an ordinary checkout', () => {
    const root = plainRepo('ordinary')
    expect(resolveGitCommonDirectory(root)).toBe(join(root, '.git'))
  })

  it('follows a linked worktree .git FILE back to the shared common directory', () => {
    // A `git worktree add` checkout stores `.git` as a file, and its own gitdir
    // carries a `commondir` pointer. `info/exclude` lives in the COMMON dir, so
    // resolving only as far as the per-worktree gitdir writes a rule git never
    // reads. TaskWraith's fanout worktrees are exactly this shape.
    const root = scratch('linked')
    const mainGit = join(root, 'main', '.git')
    const linkedGitDir = join(mainGit, 'worktrees', 'fanout-1')
    mkdirSync(linkedGitDir, { recursive: true })
    writeFileSync(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')

    const linkedRoot = join(root, 'linked')
    mkdirSync(linkedRoot, { recursive: true })
    writeFileSync(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')

    expect(resolveGitCommonDirectory(linkedRoot)).toBe(mainGit)
  })

  it('returns null when the directory is not a worktree at all', () => {
    expect(resolveGitCommonDirectory(scratch('bare'))).toBeNull()
  })
})

describe('ensureRuntimeMarkerExcluded', () => {
  it('adds the runtime marker pattern to a repo that does not ignore it', () => {
    const root = plainRepo('adds')
    const outcome = ensureRuntimeMarkerExcluded(root)

    expect(outcome.status).toBe('added')
    expect(excludeText(join(root, '.git'))).toContain(RUNTIME_MARKER_EXCLUDE_PATTERN)
  })

  it('is idempotent — a second lease neither rewrites nor duplicates the rule', () => {
    const root = plainRepo('idempotent')
    ensureRuntimeMarkerExcluded(root)
    const outcome = ensureRuntimeMarkerExcluded(root)

    expect(outcome).toEqual({ status: 'already-covered', source: 'exclude' })
    const occurrences = excludeText(join(root, '.git')).split(RUNTIME_MARKER_EXCLUDE_PATTERN).length - 1
    expect(occurrences).toBe(1)
  })

  it('writes nothing when .gitignore already covers markers broadly (the AGBench case)', () => {
    const root = plainRepo('covered')
    writeFileSync(join(root, '.gitignore'), '# markers\n.WORK-IN-PROGRESS-*.md\n', 'utf8')

    expect(ensureRuntimeMarkerExcluded(root)).toEqual({
      status: 'already-covered',
      source: 'gitignore'
    })
    expect(() => excludeText(join(root, '.git'))).toThrow()
  })

  it('preserves whatever the user already had in info/exclude', () => {
    const root = plainRepo('preserves')
    mkdirSync(join(root, '.git', 'info'), { recursive: true })
    writeFileSync(join(root, '.git', 'info', 'exclude'), '# mine\nbuild/\n', 'utf8')

    ensureRuntimeMarkerExcluded(root)

    const text = excludeText(join(root, '.git'))
    expect(text).toContain('# mine')
    expect(text).toContain('build/')
    expect(text).toContain(RUNTIME_MARKER_EXCLUDE_PATTERN)
  })

  it('skips a non-repo without throwing, so a lease never fails on hygiene', () => {
    expect(ensureRuntimeMarkerExcluded(scratch('nonrepo'))).toEqual({
      status: 'skipped',
      reason: 'not-a-git-worktree'
    })
  })

  it('reports skipped rather than throwing when the exclude path is unwritable', () => {
    const root = plainRepo('unwritable')
    // A DIRECTORY where the exclude file belongs: writing must fail softly.
    mkdirSync(join(root, '.git', 'info', 'exclude'), { recursive: true })

    const outcome = ensureRuntimeMarkerExcluded(root)
    expect(outcome.status).toBe('skipped')
  })
})

describe('git itself agrees the marker is ignored afterwards', () => {
  it('makes a real runtime marker invisible to git status', () => {
    if (!gitAvailable()) return
    const root = scratch('realgit')
    execFileSync('git', ['init', '-q'], { cwd: root })

    const marker = `.WORK-IN-PROGRESS-taskwraith-runtime-tw-instance-abcdef0123456789abcd-${'a'.repeat(64)}-${'b'.repeat(64)}.md`
    writeFileSync(join(root, marker), 'held\n', 'utf8')

    const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    expect(before).toContain('.WORK-IN-PROGRESS-taskwraith-runtime-')

    ensureRuntimeMarkerExcluded(root)

    const after = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    expect(after).not.toContain('.WORK-IN-PROGRESS-taskwraith-runtime-')
  })
})
