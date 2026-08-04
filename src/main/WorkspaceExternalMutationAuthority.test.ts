import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  createTrustedSessionExternalMutationAuthorityReceipt,
  createWorkspaceExternalMutationAuthorityReceipt
} from './WorkspaceLockRuntime'
import {
  WorkspaceExternalMutationAuthorityIssuer,
  type WorkspaceExternalMutationAuthorityIssuerDependencies
} from './WorkspaceExternalMutationAuthority'

function dependencies(
  overrides: Partial<WorkspaceExternalMutationAuthorityIssuerDependencies> = {}
): WorkspaceExternalMutationAuthorityIssuerDependencies {
  return {
    canonicalizePath: (path) => resolve(path),
    resolvePrimaryWorkspacePath: () => '/workspace',
    findValidatedSignedWriteGrant: () => undefined,
    isTrustedSessionWriteAuthorized: () => false,
    ...overrides
  }
}

function input(
  overrides: Partial<Parameters<WorkspaceExternalMutationAuthorityIssuer['issue']>[0]> = {}
): Parameters<WorkspaceExternalMutationAuthorityIssuer['issue']>[0] {
  return {
    context: {
      scope: 'workspace',
      cwd: '/workspace',
      workspacePath: '/workspace',
      appRunId: 'run-1',
      appChatId: 'chat-1',
      runtimeProfileId: 'profile-1'
    },
    provider: 'codex',
    toolName: 'write_file',
    args: { path: '/external/file.txt', content: 'new content' },
    ...overrides
  }
}

describe('WorkspaceExternalMutationAuthorityIssuer', () => {
  it('issues an exact operation-bound signed-grant receipt', () => {
    const findValidatedSignedWriteGrant = vi.fn(() => ({
      id: 'grant-1',
      signature: 'a'.repeat(64)
    }))
    const issuer = new WorkspaceExternalMutationAuthorityIssuer(
      dependencies({ findValidatedSignedWriteGrant })
    )
    const request = input()

    const receipt = issuer.issue(request)

    expect(findValidatedSignedWriteGrant).toHaveBeenCalledWith({
      context: request.context,
      provider: 'codex',
      runId: 'run-1',
      targetPath: resolve('/external/file.txt')
    })
    expect(receipt).toEqual(
      createWorkspaceExternalMutationAuthorityReceipt({
        mutation: {
          source: 'taskwraith-catalog',
          provider: 'codex',
          workspacePath: resolve('/workspace'),
          worktreePath: resolve('/workspace'),
          action: 'write_file',
          args: request.args
        },
        provider: 'codex',
        runId: 'run-1',
        targetPath: resolve('/external/file.txt'),
        grantId: 'grant-1',
        grantSignature: 'a'.repeat(64)
      })
    )
  })

  it('falls back to exact Full Access authority when no signed grant exists', () => {
    const isTrustedSessionWriteAuthorized = vi.fn(() => true)
    const issuer = new WorkspaceExternalMutationAuthorityIssuer(
      dependencies({ isTrustedSessionWriteAuthorized })
    )
    const request = input()

    const receipt = issuer.issue(request)

    expect(isTrustedSessionWriteAuthorized).toHaveBeenCalledWith({
      provider: 'codex',
      runId: 'run-1',
      targetPath: resolve('/external/file.txt'),
      chatId: 'chat-1',
      workspacePath: '/workspace',
      runtimeProfileId: 'profile-1'
    })
    expect(receipt).toEqual(
      createTrustedSessionExternalMutationAuthorityReceipt({
        mutation: {
          source: 'taskwraith-catalog',
          provider: 'codex',
          workspacePath: resolve('/workspace'),
          worktreePath: resolve('/workspace'),
          action: 'write_file',
          args: request.args
        },
        provider: 'codex',
        runId: 'run-1',
        targetPath: resolve('/external/file.txt'),
        trustContextId: JSON.stringify(['chat-1', 'run-1', 'profile-1', null, null])
      })
    )
  })

  it('binds Full Access authority to the exact ensemble participant and lane', () => {
    const isTrustedSessionWriteAuthorized = vi.fn(() => true)
    const issuer = new WorkspaceExternalMutationAuthorityIssuer(
      dependencies({ isTrustedSessionWriteAuthorized })
    )
    const ensembleRun = {
      roundId: 'round-1',
      participantId: 'participant-1',
      laneId: 'lane-1',
      provider: 'codex' as const,
      role: 'Writer',
      order: 2
    }
    const request = input({
      context: {
        scope: 'workspace',
        cwd: '/worktree',
        workspacePath: '/worktree',
        appRunId: 'run-1',
        appChatId: 'chat-1',
        runtimeProfileId: 'profile-1',
        ensembleRun
      }
    })

    const receipt = issuer.issue(request)

    expect(isTrustedSessionWriteAuthorized).toHaveBeenCalledWith({
      provider: 'codex',
      runId: 'run-1',
      targetPath: resolve('/external/file.txt'),
      chatId: 'chat-1',
      workspacePath: '/worktree',
      runtimeProfileId: 'profile-1',
      ensembleRun
    })
    expect(receipt).toMatchObject({
      kind: 'validated-trusted-session-external-write',
      trustContextId: JSON.stringify(['chat-1', 'run-1', 'profile-1', 'participant-1', 'lane-1'])
    })
  })

  it('prefers the signed grant without consulting Full Access', () => {
    const isTrustedSessionWriteAuthorized = vi.fn(() => true)
    const issuer = new WorkspaceExternalMutationAuthorityIssuer(
      dependencies({
        findValidatedSignedWriteGrant: () => ({
          id: 'grant-1',
          signature: 'b'.repeat(64)
        }),
        isTrustedSessionWriteAuthorized
      })
    )

    expect(issuer.issue(input())?.kind).toBe('validated-external-path-grant')
    expect(isTrustedSessionWriteAuthorized).not.toHaveBeenCalled()
  })

  it('does not issue authority outside supported workspace mutations', () => {
    const findValidatedSignedWriteGrant = vi.fn()
    const issuer = new WorkspaceExternalMutationAuthorityIssuer(
      dependencies({ findValidatedSignedWriteGrant })
    )

    expect(issuer.issue(input({ context: { scope: 'global', cwd: '/workspace' } }))).toBeUndefined()
    expect(issuer.issue(input({ toolName: 'read_file' }))).toBeUndefined()
    expect(
      issuer.issue(
        input({
          context: { scope: 'workspace', cwd: '/workspace' },
          args: { path: '/external/file.txt' }
        })
      )
    ).toBeUndefined()
    expect(issuer.issue(input({ args: { path: 'inside.txt' } }))).toBeUndefined()
    expect(findValidatedSignedWriteGrant).not.toHaveBeenCalled()
  })

  it('uses injected canonicalization to detect a symlink escape', () => {
    const findValidatedSignedWriteGrant = vi.fn(() => ({
      id: 'grant-2',
      signature: 'c'.repeat(64)
    }))
    const issuer = new WorkspaceExternalMutationAuthorityIssuer(
      dependencies({
        canonicalizePath: (path) =>
          resolve(path) === resolve('/workspace/link/file.txt')
            ? resolve('/external/file.txt')
            : resolve(path),
        findValidatedSignedWriteGrant
      })
    )

    expect(
      issuer.issue(input({ args: { path: '/workspace/link/file.txt', content: 'x' } }))?.targetPath
    ).toBe(resolve('/external/file.txt'))
  })

  it('preserves exact target bytes and fails closed when canonicalization is unavailable', () => {
    const observedTargets: string[] = []
    const issuer = new WorkspaceExternalMutationAuthorityIssuer(
      dependencies({
        canonicalizePath: (path) => {
          observedTargets.push(path)
          return path.includes('unavailable') ? null : resolve(path)
        },
        findValidatedSignedWriteGrant: () => ({
          id: 'grant-3',
          signature: 'd'.repeat(64)
        })
      })
    )

    expect(
      issuer.issue(input({ args: { path: '/external/file.txt ', content: 'x' } }))?.targetPath
    ).toBe(resolve('/external/file.txt '))
    expect(observedTargets).toContain(resolve('/external/file.txt '))
    expect(
      issuer.issue(input({ args: { path: '/external/unavailable', content: 'x' } }))
    ).toBeUndefined()
  })

  it('binds the receipt fingerprint to the primary workspace and exact replacement args', () => {
    const issuer = new WorkspaceExternalMutationAuthorityIssuer(
      dependencies({
        resolvePrimaryWorkspacePath: () => '/primary-workspace',
        findValidatedSignedWriteGrant: () => ({
          id: 'grant-4',
          signature: 'e'.repeat(64)
        })
      })
    )
    const request = input({
      toolName: 'replace',
      args: {
        file_path: '/external/file.txt',
        old_string: 'old',
        new_string: 'new'
      }
    })

    expect(issuer.issue(request)).toEqual(
      createWorkspaceExternalMutationAuthorityReceipt({
        mutation: {
          source: 'taskwraith-catalog',
          provider: 'codex',
          workspacePath: resolve('/primary-workspace'),
          worktreePath: resolve('/workspace'),
          action: 'replace',
          args: request.args
        },
        provider: 'codex',
        runId: 'run-1',
        targetPath: resolve('/external/file.txt'),
        grantId: 'grant-4',
        grantSignature: 'e'.repeat(64)
      })
    )
  })
})
