import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexGitMetadataRootsForWorkspace, codexSandboxForMode } from './CodexRunPolicy'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-codex-policy-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('codexSandboxForMode', () => {
  it('uses read-only only for plan mode', () => {
    expect(codexSandboxForMode('plan')).toBe('read-only')
    expect(codexSandboxForMode('default')).toBe('workspace-write')
    expect(codexSandboxForMode('auto_edit')).toBe('workspace-write')
    expect(codexSandboxForMode(undefined)).toBe('workspace-write')
  })
})

describe('codexGitMetadataRootsForWorkspace', () => {
  it('includes a normal repository .git directory', async () => {
    const root = makeTempRoot()
    const workspace = join(root, 'repo')
    const gitDir = join(workspace, '.git')
    await mkdir(gitDir, { recursive: true })

    expect(codexGitMetadataRootsForWorkspace(workspace)).toEqual([realpathSync(gitDir)])
  })

  it('includes linked-worktree gitdir and common dir', async () => {
    const root = makeTempRoot()
    const workspace = join(root, 'worktree')
    const commonGitDir = join(root, 'main.git')
    const worktreeGitDir = join(commonGitDir, 'worktrees', 'worktree')
    await mkdir(workspace, { recursive: true })
    await mkdir(worktreeGitDir, { recursive: true })
    writeFileSync(join(workspace, '.git'), 'gitdir: ../main.git/worktrees/worktree\n')
    writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n')

    expect(codexGitMetadataRootsForWorkspace(workspace)).toEqual([
      realpathSync(worktreeGitDir),
      realpathSync(commonGitDir)
    ])
  })

  it('returns an empty list when no git metadata is present', () => {
    const root = makeTempRoot()
    const workspace = resolve(root, 'plain')

    expect(existsSync(workspace)).toBe(false)
    expect(codexGitMetadataRootsForWorkspace(workspace)).toEqual([])
  })
})
