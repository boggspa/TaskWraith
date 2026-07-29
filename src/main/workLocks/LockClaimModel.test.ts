import { describe, expect, it } from 'vitest'
import type { WorkspaceLockClaimRequest } from './WorkspaceLockTypes'
import {
  canonicalizeWorkspaceLockClaim,
  compareWorkspaceLockClaims,
  sortWorkspaceLockClaims,
  validateWorkspaceLockClaimRequest,
  workspaceLockClaimsConflict,
  workspaceLockPathContains
} from './LockClaimModel'

const canonicalizePath = (value: string): string =>
  value.trim().replace('/alias/project', '/repos/project').replace(/\\/g, '/')

function claim(overrides: Partial<WorkspaceLockClaimRequest> = {}) {
  return canonicalizeWorkspaceLockClaim(
    {
      workspacePath: '/alias/project',
      worktreePath: '/alias/project',
      kind: 'file',
      mode: 'write',
      targetPath: '/alias/project/src/App.ts',
      ...overrides
    },
    canonicalizePath
  )
}

describe('LockClaimModel', () => {
  it('validates request shape before durable acquisition', () => {
    expect(validateWorkspaceLockClaimRequest({ kind: 'hunk' })).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        'workspacePath is required.',
        'hunk claims require targetPath.'
      ])
    })
    expect(
      validateWorkspaceLockClaimRequest({
        workspacePath: '/repo',
        kind: 'hunk',
        targetPath: '/repo/a.ts',
        hunk: { baseline: '', startLine: 4, endLine: 3 }
      })
    ).toEqual({ ok: false, errors: expect.any(Array) })
  })

  it('derives all identities with the injected canonicalizer and rejects an escaped target', () => {
    const normalized = claim()
    expect(normalized).toMatchObject({
      workspaceIdentity: '/repos/project',
      worktreeIdentity: '/repos/project',
      physicalTargetIdentity: '/repos/project/src/App.ts'
    })
    expect(() => claim({ targetPath: '/alias/elsewhere/secret.ts' })).toThrow(
      'inside the selected worktree'
    )
  })

  it('isolates separate worktrees even when they share a workspace', () => {
    const base = claim()
    const linked = claim({
      worktreePath: '/worktrees/project-feature',
      targetPath: '/worktrees/project-feature/src/App.ts'
    })
    const otherWorkspace = claim({
      workspacePath: '/other',
      worktreePath: '/other',
      targetPath: '/other/src/App.ts'
    })

    expect(workspaceLockClaimsConflict(base, linked)).toBe(false)
    expect(workspaceLockClaimsConflict(base, otherWorkspace)).toBe(false)
  })

  it('conflicts exact object aliases across worktree domains and honors global filesystem scope', () => {
    const first = {
      ...claim(),
      objectIdentity: 'dev:7:ino:42'
    }
    const hardLinkInAnotherRoot = {
      ...claim({
        workspacePath: '/other',
        worktreePath: '/other',
        targetPath: '/other/alias.ts'
      }),
      objectIdentity: 'dev:7:ino:42'
    }
    expect(workspaceLockClaimsConflict(first, hardLinkInAnotherRoot)).toBe(true)

    const bindRootIdentity = 'dev:7:ino:root'
    const treeThroughFirstRoot = {
      ...claim({ kind: 'tree', targetPath: '/alias/project/src' }),
      worktreeObjectIdentity: bindRootIdentity
    }
    const fileThroughBindAlias = {
      ...claim({
        workspacePath: '/mounted',
        worktreePath: '/mounted',
        targetPath: '/mounted/src/nested/file.ts'
      }),
      worktreeObjectIdentity: bindRootIdentity
    }
    expect(workspaceLockClaimsConflict(treeThroughFirstRoot, fileThroughBindAlias)).toBe(true)

    const global = claim({
      workspacePath: '/other',
      worktreePath: '/other',
      kind: 'workspace',
      globalFilesystem: true
    })
    expect(global.globalFilesystem).toBe(true)
    expect(workspaceLockClaimsConflict(first, global)).toBe(true)
    expect(
      validateWorkspaceLockClaimRequest({
        workspacePath: '/repo',
        kind: 'file',
        targetPath: '/repo/a.ts',
        globalFilesystem: true
      })
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        'globalFilesystem is valid only for a write-mode workspace claim.'
      ])
    })
  })

  it('uses reader-writer semantics across workspace, tree, and file hierarchy', () => {
    const fileWriter = claim()
    expect(workspaceLockClaimsConflict(claim({ mode: 'read' }), claim({ mode: 'read' }))).toBe(
      false
    )
    expect(workspaceLockClaimsConflict(fileWriter, claim({ kind: 'workspace' }))).toBe(true)
    expect(
      workspaceLockClaimsConflict(
        fileWriter,
        claim({ kind: 'tree', targetPath: '/alias/project/src' })
      )
    ).toBe(true)
    expect(
      workspaceLockClaimsConflict(
        fileWriter,
        claim({ kind: 'tree', targetPath: '/alias/project/src/application' })
      )
    ).toBe(false)
    expect(
      workspaceLockClaimsConflict(
        claim({ kind: 'tree', targetPath: '/alias/project/src/nested' }),
        claim({ kind: 'tree', targetPath: '/alias/project/src' })
      )
    ).toBe(true)
    expect(workspaceLockPathContains('/repo/src', '/repo/src-a/file.ts')).toBe(false)
  })

  it('allows same-baseline disjoint half-open hunks while rejecting overlapping ranges', () => {
    const first = claim({
      kind: 'hunk',
      targetPath: '/alias/project/src/App.ts',
      hunk: { baseline: 'rev-a', startLine: 4, endLine: 8 }
    })
    const disjoint = claim({
      kind: 'hunk',
      targetPath: '/alias/project/src/App.ts',
      hunk: { baseline: 'rev-a', startLine: 8, endLine: 12 }
    })
    const overlapping = claim({
      kind: 'hunk',
      targetPath: '/alias/project/src/App.ts',
      hunk: { baseline: 'rev-a', startLine: 7, endLine: 12 }
    })
    const differentBaseline = claim({
      kind: 'hunk',
      targetPath: '/alias/project/src/App.ts',
      hunk: { baseline: 'rev-b', startLine: 12, endLine: 15 }
    })

    expect(workspaceLockClaimsConflict(first, disjoint)).toBe(false)
    expect(workspaceLockClaimsConflict(first, overlapping)).toBe(true)
    expect(workspaceLockClaimsConflict(first, differentBaseline)).toBe(true)
  })

  it('treats insertions at the same anchor, inside a hunk, or on either boundary as conflicting', () => {
    const range = claim({
      kind: 'hunk',
      hunk: { baseline: 'rev-a', startLine: 4, endLine: 8 }
    })
    const sameAnchor = claim({
      kind: 'hunk',
      hunk: { baseline: 'rev-a', startLine: 6, endLine: 6 }
    })
    const anotherAtAnchor = claim({
      kind: 'hunk',
      hunk: { baseline: 'rev-a', startLine: 6, endLine: 6 }
    })
    const startBoundary = claim({
      kind: 'hunk',
      hunk: { baseline: 'rev-a', startLine: 4, endLine: 4 }
    })
    const endBoundary = claim({
      kind: 'hunk',
      hunk: { baseline: 'rev-a', startLine: 8, endLine: 8 }
    })

    expect(workspaceLockClaimsConflict(range, sameAnchor)).toBe(true)
    expect(workspaceLockClaimsConflict(sameAnchor, anotherAtAnchor)).toBe(true)
    expect(workspaceLockClaimsConflict(range, startBoundary)).toBe(true)
    expect(workspaceLockClaimsConflict(range, endBoundary)).toBe(true)
  })

  it('sorts canonical claims without mutating caller-owned arrays', () => {
    const unsorted = [
      claim({ targetPath: '/alias/project/src/z.ts' }),
      claim({ kind: 'workspace' }),
      claim({ targetPath: '/alias/project/src/a.ts' })
    ]
    const sorted = sortWorkspaceLockClaims(unsorted)

    expect(unsorted.map((entry) => entry.kind)).toEqual(['file', 'workspace', 'file'])
    expect(sorted.map((entry) => entry.kind)).toEqual(['workspace', 'file', 'file'])
    expect(compareWorkspaceLockClaims(sorted[0], sorted[1])).toBeLessThan(0)
  })
})
