import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codexGitMetadataRootsForWorkspace,
  codexNativeAutoApprovalFromPosture,
  codexSandboxForMode
} from './CodexRunPolicy'

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

  it('keeps a workspace sandbox even under a full-access grant', () => {
    expect(codexSandboxForMode('auto_edit', true)).toBe('workspace-write')
    expect(codexSandboxForMode('default', true)).toBe('workspace-write')
    // A full-access grant does not turn a workspace run into host access.
    expect(codexSandboxForMode('auto_edit', false)).toBe('workspace-write')
    expect(codexSandboxForMode('default')).toBe('workspace-write')
  })

  it('never lets a full-access flag override the plan read-only floor', () => {
    // plan + full_access is mutually exclusive in practice, but if the flag ever
    // leaked onto a plan run the read-only floor must still win.
    expect(codexSandboxForMode('plan', true)).toBe('read-only')
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

describe('codexNativeAutoApprovalFromPosture (slice D — posture-honoring native gate)', () => {
  const posture = (presetId: string, shell: string, file: string) =>
    ({ presetId, agenticServices: { shellCommands: shell, fileChanges: file } }) as never

  it('auto-approves native codex tools when the SIGNED posture is a write tier with shell+file allow', () => {
    expect(codexNativeAutoApprovalFromPosture(posture('workspace_write', 'allow', 'allow'))).toBe(
      true
    )
    expect(codexNativeAutoApprovalFromPosture(posture('full_access', 'allow', 'allow'))).toBe(true)
  })

  it('never auto-approves from read tiers, Accept Edits, or when the global kill switch survived the clamp', () => {
    expect(codexNativeAutoApprovalFromPosture(posture('default', 'allow', 'allow'))).toBe(false)
    expect(codexNativeAutoApprovalFromPosture(posture('read_only', 'allow', 'allow'))).toBe(false)
    expect(codexNativeAutoApprovalFromPosture(posture('plan', 'allow', 'allow'))).toBe(false)
    // A global deny is preserved into the resolved services (preserveExplicitDeny):
    // the posture path must respect it exactly like the settings path did.
    expect(codexNativeAutoApprovalFromPosture(posture('workspace_write', 'deny', 'allow'))).toBe(
      false
    )
    expect(codexNativeAutoApprovalFromPosture(posture('full_access', 'allow', 'ask'))).toBe(false)
    expect(codexNativeAutoApprovalFromPosture(undefined)).toBe(false)
    expect(codexNativeAutoApprovalFromPosture(null)).toBe(false)
  })
})
