import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codexGitMetadataRootsForWorkspace,
  codexNativeAutoApprovalFromPosture,
  codexSandboxForMode,
  resolveDesktopCodexSandboxControls
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

  it('drops the sandbox under a signed full-access grant', () => {
    // Full Access is meant to be exactly as wide as the picker says it is:
    // the grant drops the native sandbox so signing/archiving can reach the
    // login keychain and ~/Library. The user is warned before granting it.
    expect(codexSandboxForMode('auto_edit', true)).toBe('danger-full-access')
    expect(codexSandboxForMode('default', true)).toBe('danger-full-access')
    // Without the signed grant the run stays workspace-confined. The flag is
    // the ONLY thing that widens it — approval mode alone never does.
    expect(codexSandboxForMode('auto_edit', false)).toBe('workspace-write')
    expect(codexSandboxForMode('default')).toBe('workspace-write')
  })

  it('never lets a full-access flag override the plan read-only floor', () => {
    // plan + full_access is mutually exclusive in practice, but if the flag ever
    // leaked onto a plan run the read-only floor must still win — the floor
    // outranks the widening, not the other way round.
    expect(codexSandboxForMode('plan', true)).toBe('read-only')
  })
})

describe('resolveDesktopCodexSandboxControls', () => {
  it('keeps ordinary workspace runs on the exact-mutation read-only boundary', () => {
    const workspace = makeTempRoot()
    expect(
      resolveDesktopCodexSandboxControls({
        approvalMode: 'auto_edit',
        workspace,
        scope: 'workspace',
        fullAccessGranted: false,
        networkAccess: true
      })
    ).toEqual({
      sandbox: 'read-only',
      sandboxPolicy: {
        type: 'readOnly',
        readableRoots: [resolve(workspace)],
        networkAccess: false
      }
    })
  })

  it.each(['workspace', 'global'] as const)(
    'uses the exact Full Access pair for %s scope',
    (scope) => {
      expect(
        resolveDesktopCodexSandboxControls({
          approvalMode: 'auto_edit',
          workspace: makeTempRoot(),
          scope,
          fullAccessGranted: true,
          networkAccess: false
        })
      ).toEqual({
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' }
      })
    }
  )

  it('preserves the global host-root and network projection below Full Access', () => {
    const workspace = makeTempRoot()
    const hostRoot = parse(resolve(workspace)).root
    expect(
      resolveDesktopCodexSandboxControls({
        approvalMode: 'default',
        workspace,
        scope: 'global',
        fullAccessGranted: false,
        networkAccess: true
      })
    ).toEqual({
      sandbox: 'workspace-write',
      sandboxPolicy: {
        type: 'workspaceWrite',
        readableRoots: [hostRoot],
        writableRoots: [hostRoot],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    })
  })

  it('keeps Plan read-only even with a Full Access flag', () => {
    expect(
      resolveDesktopCodexSandboxControls({
        approvalMode: 'plan',
        workspace: makeTempRoot(),
        scope: 'global',
        fullAccessGranted: true,
        networkAccess: true
      })
    ).toMatchObject({
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    })
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
