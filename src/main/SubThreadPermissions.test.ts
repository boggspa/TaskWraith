import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  inheritedSubThreadPermissions,
  resolveSubThreadWorkerPermissions
} from './SubThreadPermissions'
import type { EffectiveRunPermissions } from './store/types'

const readOnly = {
  presetId: 'read_only',
  approvalMode: 'plan',
  agenticServices: {
    shellCommands: 'deny',
    fileChanges: 'deny',
    mcpTools: 'ask',
    subThreadDelegation: 'ask'
  },
  networkAccess: 'deny',
  readOnly: true,
  externalPathGrants: [],
  workspaceGrantServiceIds: []
} as unknown as EffectiveRunPermissions

const fullAccess = {
  ...readOnly,
  presetId: 'full_access',
  approvalMode: 'auto_edit',
  agenticServices: {
    ...readOnly.agenticServices,
    shellCommands: 'allow',
    fileChanges: 'allow',
    externalPublish: 'allow'
  },
  networkAccess: 'allow',
  readOnly: false,
  externalPathGrants: [
    {
      id: 'write-grant',
      provider: 'codex',
      path: '/tmp/outside',
      kind: 'directory',
      access: 'write',
      duration: 'thisRun',
      createdAt: '2026-07-11T12:00:00.000Z'
    }
  ]
} as EffectiveRunPermissions

describe('inheritedSubThreadPermissions', () => {
  it('carries a read-only parent posture to the sub-thread (no escalation)', () => {
    const inherited = inheritedSubThreadPermissions({ effectivePermissions: readOnly })
    expect(inherited?.agenticServices.shellCommands).toBe('deny')
    expect(inherited?.agenticServices.fileChanges).toBe('deny')
    expect(inherited?.readOnly).toBe(true)
  })

  it('returns undefined when the parent has no explicit posture', () => {
    expect(inheritedSubThreadPermissions({})).toBeUndefined()
  })

  it('defaults async workers to a trusted main-derived read-only floor', () => {
    const decision = resolveSubThreadWorkerPermissions({
      parentPermissions: fullAccess,
      readOnlyPermissions: readOnly
    })

    expect(decision).toMatchObject({
      ok: true,
      isolation: 'read_only',
      sessionTrust: false,
      effectivePermissions: {
        presetId: 'read_only',
        approvalMode: 'plan',
        readOnly: true,
        networkAccess: 'deny'
      }
    })
    if (decision.ok) {
      expect(decision.effectivePermissions.agenticServices.shellCommands).toBe('deny')
      expect(decision.effectivePermissions.agenticServices.fileChanges).toBe('deny')
      expect(decision.effectivePermissions.externalPathGrants).toEqual([])
    }
  })

  it('allows a distinct isolated worktree but never carries Full Access host authority', () => {
    const decision = resolveSubThreadWorkerPermissions({
      parentPermissions: fullAccess,
      readOnlyPermissions: readOnly,
      isolation: {
        kind: 'worktree',
        baseWorkspacePath: '/repo',
        effectiveWorkspacePath: '/repo-worktrees/worker-1'
      }
    })

    expect(decision).toMatchObject({
      ok: true,
      isolation: 'worktree',
      sessionTrust: false,
      effectiveWorkspacePath: resolve('/repo-worktrees/worker-1'),
      effectivePermissions: {
        presetId: 'workspace_write',
        readOnly: false
      }
    })
    if (decision.ok) {
      expect(decision.effectivePermissions.agenticServices.fileChanges).toBe('allow')
      expect(decision.effectivePermissions.externalPathGrants).toEqual([])
    }
  })

  it('rejects a worktree request that aliases the parent checkout', () => {
    expect(
      resolveSubThreadWorkerPermissions({
        parentPermissions: fullAccess,
        readOnlyPermissions: readOnly,
        isolation: {
          kind: 'worktree',
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/repo/.'
        }
      })
    ).toMatchObject({ ok: false, isolation: 'worktree' })
  })

  it('rejects direct-checkout writers without narrow scopes, a lease, and host enforcement', () => {
    for (const isolation of [
      {
        kind: 'direct_checkout' as const,
        workspacePath: '/repo',
        writeScopes: ['**'],
        leaseId: 'lease-1',
        lockAwareHostEnforcement: true
      },
      {
        kind: 'direct_checkout' as const,
        workspacePath: '/repo',
        writeScopes: ['src/worker/**']
      },
      {
        kind: 'direct_checkout' as const,
        workspacePath: '/repo',
        writeScopes: ['src/worker/**'],
        leaseId: 'lease-1',
        lockAwareHostEnforcement: false
      }
    ]) {
      expect(
        resolveSubThreadWorkerPermissions({
          parentPermissions: fullAccess,
          readOnlyPermissions: readOnly,
          isolation
        })
      ).toMatchObject({ ok: false, isolation: 'direct_checkout' })
    }
  })

  it('accepts an explicitly scoped and leased direct-checkout writer under the parent ceiling', () => {
    const decision = resolveSubThreadWorkerPermissions({
      parentPermissions: fullAccess,
      readOnlyPermissions: readOnly,
      isolation: {
        kind: 'direct_checkout',
        workspacePath: '/repo',
        writeScopes: ['src/worker/**', 'tests/worker/**', 'src/worker/**'],
        leaseId: 'lease-1',
        lockAwareHostEnforcement: true
      }
    })

    expect(decision).toMatchObject({
      ok: true,
      isolation: 'direct_checkout',
      sessionTrust: false,
      effectiveWorkspacePath: resolve('/repo'),
      writeScopes: ['src/worker/**', 'tests/worker/**'],
      leaseId: 'lease-1',
      effectivePermissions: { presetId: 'workspace_write', readOnly: false }
    })
  })

  it('rejects a direct-checkout writer when the parent is read-only', () => {
    expect(
      resolveSubThreadWorkerPermissions({
        parentPermissions: readOnly,
        readOnlyPermissions: readOnly,
        isolation: {
          kind: 'direct_checkout',
          workspacePath: '/repo',
          writeScopes: ['src/worker/**'],
          leaseId: 'lease-1',
          lockAwareHostEnforcement: true
        }
      })
    ).toMatchObject({
      ok: false,
      isolation: 'direct_checkout',
      reason: expect.stringMatching(/parent/i)
    })
  })
})
