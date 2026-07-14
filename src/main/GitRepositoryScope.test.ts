import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  externalGitRepositoryRootIsSelfContained,
  gitRepositoryRootForPath,
  registeredWorkspaceGitRootIsAllowed
} from './GitRepositoryScope'

const tempPaths: string[] = []

function makeTempDir(): string {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-git-scope-'))
  tempPaths.push(tempPath)
  return tempPath
}

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true })
  }
})

describe('gitRepositoryRootForPath', () => {
  it('returns a repository root', () => {
    const repositoryRoot = makeTempDir()
    fs.mkdirSync(path.join(repositoryRoot, '.git'))

    expect(gitRepositoryRootForPath(repositoryRoot, (candidate) => candidate)).toBe(
      fs.realpathSync.native(repositoryRoot)
    )
  })

  it('walks from a subdirectory to its repository root', () => {
    const repositoryRoot = makeTempDir()
    const subdirectory = path.join(repositoryRoot, 'packages', 'app')
    fs.mkdirSync(path.join(repositoryRoot, '.git'))
    fs.mkdirSync(subdirectory, { recursive: true })

    expect(gitRepositoryRootForPath(subdirectory, () => repositoryRoot)).toBe(
      fs.realpathSync.native(repositoryRoot)
    )
  })

  it('returns null outside a repository', () => {
    expect(gitRepositoryRootForPath(makeTempDir(), () => null)).toBeNull()
  })

  it('does not treat a nested child repository as the registered root repository', () => {
    const registeredRoot = makeTempDir()
    const nestedRepository = path.join(registeredRoot, 'nested-repository')
    const init = spawnSync('git', ['init', '--quiet', nestedRepository], { encoding: 'utf8' })
    expect(init.status, init.stderr).toBe(0)

    expect(gitRepositoryRootForPath(registeredRoot)).toBeNull()
  })

  it('accepts a regular .git file used by worktrees', () => {
    const repositoryRoot = makeTempDir()
    fs.writeFileSync(path.join(repositoryRoot, '.git'), 'gitdir: /tmp/example-worktree\n')

    expect(gitRepositoryRootForPath(repositoryRoot, (candidate) => candidate)).toBe(
      fs.realpathSync.native(repositoryRoot)
    )
  })

  it('resolves a symlinked candidate path before finding the repository', () => {
    const tempRoot = makeTempDir()
    const repositoryRoot = path.join(tempRoot, 'repository')
    const subdirectory = path.join(repositoryRoot, 'src')
    const aliasPath = path.join(tempRoot, 'repository-alias')
    fs.mkdirSync(path.join(repositoryRoot, '.git'), { recursive: true })
    fs.mkdirSync(subdirectory)
    fs.symlinkSync(subdirectory, aliasPath, 'dir')

    expect(gitRepositoryRootForPath(aliasPath, () => repositoryRoot)).toBe(
      fs.realpathSync.native(repositoryRoot)
    )
  })

  it('rejects a symlinked .git marker', () => {
    const tempRoot = makeTempDir()
    const repositoryRoot = path.join(tempRoot, 'repository')
    const gitDirectory = path.join(tempRoot, 'git-directory')
    fs.mkdirSync(repositoryRoot)
    fs.mkdirSync(gitDirectory)
    fs.symlinkSync(gitDirectory, path.join(repositoryRoot, '.git'), 'dir')

    expect(gitRepositoryRootForPath(repositoryRoot, () => repositoryRoot)).toBeNull()
  })

  it('rejects a .git indirection whose actual Git worktree is outside the candidate', () => {
    const tempRoot = makeTempDir()
    const backingRepository = path.join(tempRoot, 'backing')
    const signedDirectory = path.join(tempRoot, 'signed')
    const outsideWorktree = path.join(tempRoot, 'outside')
    fs.mkdirSync(signedDirectory)
    fs.mkdirSync(outsideWorktree)
    const init = spawnSync('git', ['init', '--quiet', backingRepository], { encoding: 'utf8' })
    expect(init.status, init.stderr).toBe(0)
    const configure = spawnSync(
      'git',
      ['--git-dir', path.join(backingRepository, '.git'), 'config', 'core.worktree', outsideWorktree],
      { encoding: 'utf8' }
    )
    expect(configure.status, configure.stderr).toBe(0)
    fs.writeFileSync(
      path.join(signedDirectory, '.git'),
      `gitdir: ${path.join(backingRepository, '.git')}\n`
    )

    expect(gitRepositoryRootForPath(signedDirectory)).toBeNull()
  })
})

describe('externalGitRepositoryRootIsSelfContained', () => {
  it('accepts a real .git directory inside the external repository root', () => {
    const repositoryRoot = makeTempDir()
    fs.mkdirSync(path.join(repositoryRoot, '.git'))

    expect(externalGitRepositoryRootIsSelfContained(repositoryRoot)).toBe(true)
  })

  it('rejects a .git file even though registered workspaces may use one for worktrees', () => {
    const repositoryRoot = makeTempDir()
    fs.writeFileSync(path.join(repositoryRoot, '.git'), 'gitdir: /tmp/example-worktree\n')

    expect(externalGitRepositoryRootIsSelfContained(repositoryRoot)).toBe(false)
  })

  it('rejects a symlinked .git directory', () => {
    const tempRoot = makeTempDir()
    const repositoryRoot = path.join(tempRoot, 'repository')
    const redirectedGitDirectory = path.join(tempRoot, 'redirected-git-directory')
    fs.mkdirSync(repositoryRoot)
    fs.mkdirSync(redirectedGitDirectory)
    fs.symlinkSync(redirectedGitDirectory, path.join(repositoryRoot, '.git'), 'dir')

    expect(externalGitRepositoryRootIsSelfContained(repositoryRoot)).toBe(false)
  })

  it('rejects missing roots and missing .git markers', () => {
    const repositoryRoot = makeTempDir()

    expect(externalGitRepositoryRootIsSelfContained(repositoryRoot)).toBe(false)
    expect(externalGitRepositoryRootIsSelfContained(path.join(repositoryRoot, 'missing'))).toBe(
      false
    )
  })
})

describe('registeredWorkspaceGitRootIsAllowed', () => {
  it('allows a registered plain directory outside Git', () => {
    expect(registeredWorkspaceGitRootIsAllowed('/workspace/plain', null)).toBe(true)
  })

  it('allows the registered repository root itself', () => {
    expect(registeredWorkspaceGitRootIsAllowed('/workspace/repo', '/workspace/repo')).toBe(true)
  })

  it('rejects a registered subdirectory whose Git root is an ancestor', () => {
    expect(registeredWorkspaceGitRootIsAllowed('/workspace/repo/app', '/workspace/repo')).toBe(
      false
    )
  })
})
