import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PermissionOpportunityRegistry } from './PermissionOpportunityRegistry'
import {
  buildPermissionOpportunityBinding,
  createPermissionOpportunityResolver,
  issueHostPermissionOpportunity
} from './PermissionOpportunityRuntime'

const tempPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskwraith-permission-binding-'))
  tempPaths.push(root)
  const workspace = join(root, 'workspace')
  const worktree = join(root, 'worktree')
  await Promise.all([mkdir(workspace), mkdir(worktree)])
  return { root, workspace, worktree }
}

function baseInput(workspace: string, worktree: string) {
  return {
    provider: 'codex' as const,
    runId: 'run-1',
    chatId: 'chat-1',
    profileId: 'taskwraith-gateway-v17' as const,
    workspaceId: 'workspace-1',
    primaryWorkspacePath: workspace,
    effectiveWorkspacePath: worktree,
    providerSessionId: 'session-1',
    participantId: 'participant-1',
    laneId: 'lane-1',
    postureFingerprint: 'posture-1',
    fixedToolAllowlist: ['write_file', 'read_file', 'write_file']
  }
}

describe('PermissionOpportunityRuntime', () => {
  it('binds logical workspace identity, real workspace, effective worktree, posture and tool ceiling', async () => {
    const { workspace, worktree } = await workspaceFixture()
    const binding = buildPermissionOpportunityBinding(baseInput(workspace, worktree))
    expect(binding).toMatchObject({
      workspaceId: 'workspace-1',
      workspacePath: workspace,
      workspaceRealPath: await realpath(workspace),
      effectiveWorktreePath: await realpath(worktree),
      participantId: 'participant-1',
      laneId: 'lane-1',
      postureFingerprint: 'posture-1',
      fixedToolAllowlistFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  })

  it('fails closed on partial workspace or lane identity and canonicalizes path aliases', async () => {
    const { root, workspace, worktree } = await workspaceFixture()
    expect(
      buildPermissionOpportunityBinding({
        ...baseInput(workspace, worktree),
        workspaceId: null
      })
    ).toBeNull()
    expect(
      buildPermissionOpportunityBinding({
        ...baseInput(workspace, worktree),
        participantId: null
      })
    ).toBeNull()

    const alias = join(root, 'workspace-alias')
    await symlink(workspace, alias)
    expect(
      buildPermissionOpportunityBinding({
        ...baseInput(alias, worktree),
        primaryWorkspacePath: alias
      })
    ).toMatchObject({ workspacePath: alias, workspaceRealPath: await realpath(workspace) })
  })

  it('recomputes the live binding immediately before consume', async () => {
    const { workspace, worktree } = await workspaceFixture()
    const registry = new PermissionOpportunityRegistry()
    const issuedBinding = buildPermissionOpportunityBinding(baseInput(workspace, worktree))
    if (!issuedBinding) throw new Error('Expected binding.')
    const issued = registry.issue({
      binding: issuedBinding,
      request: {
        toolName: 'write_file',
        arguments: { path: 'notes.txt', content: 'hello' },
        failure: 'host-classified boundary',
        boundaryCode: 'policy_denied'
      }
    })
    if (!issued.ok) throw new Error(issued.error)
    let liveBinding = issuedBinding
    const resolver = createPermissionOpportunityResolver({
      registry,
      getLiveBinding: () => liveBinding
    })
    const resolved = await resolver(issued.opportunity.permissionOpportunityId)
    if (!resolved.ok) throw new Error(resolved.error)
    liveBinding = { ...issuedBinding, postureFingerprint: 'posture-2' }

    expect(await resolved.reservation.consumeWithLiveBinding()).toMatchObject({
      ok: false,
      code: 'opportunity_binding_mismatch'
    })
    expect(registry.status(issued.opportunity.permissionOpportunityId)).toMatchObject({
      state: 'reserved'
    })
  })

  it('retains the validated target in main and returns only an opaque redemption instruction', async () => {
    const { workspace, worktree } = await workspaceFixture()
    const binding = buildPermissionOpportunityBinding(baseInput(workspace, worktree))
    const registry = new PermissionOpportunityRegistry()
    const result = issueHostPermissionOpportunity({
      registry,
      binding,
      boundaryCode: 'policy_denied',
      toolName: 'write_file',
      arguments: { path: 'private-plan.txt', content: 'retained by main' },
      failure: 'Permission denied by TaskWraith policy.',
      userDeclined: false,
      definitions: [
        {
          name: 'write_file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false
          }
        }
      ],
      isAutoAllowed: () => false
    })

    expect(result).toMatchObject({
      ok: true,
      instruction: {
        tool: 'redeem_permission_opportunity',
        arguments: { permissionOpportunityId: expect.stringMatching(/^twp_/) }
      }
    })
    expect(JSON.stringify(result)).not.toContain('private-plan.txt')
    expect(JSON.stringify(result)).not.toContain('Permission denied')
    expect(registry.size()).toBe(1)
  })

  it('trusts the typed host boundary while rejecting explicit decline or incomplete binding', async () => {
    const { workspace, worktree } = await workspaceFixture()
    const registry = new PermissionOpportunityRegistry()
    const common = {
      registry,
      boundaryCode: 'policy_denied' as const,
      toolName: 'write_file' as const,
      arguments: { path: 'notes.txt', content: 'hello' },
      failure: 'ordinary application error',
      userDeclined: false,
      definitions: [
        {
          name: 'write_file' as const,
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content']
          }
        }
      ],
      isAutoAllowed: () => false
    }
    const binding = buildPermissionOpportunityBinding(baseInput(workspace, worktree))
    expect(issueHostPermissionOpportunity({ ...common, binding })).toMatchObject({ ok: true })
    expect(
      issueHostPermissionOpportunity({ ...common, binding, userDeclined: true })
    ).toMatchObject({ ok: false, code: 'explicit_user_decline' })
    expect(
      issueHostPermissionOpportunity({ ...common, binding, boundaryCode: 'unscoped_process' })
    ).toMatchObject({ ok: false, code: 'invalid_boundary_target' })
    expect(issueHostPermissionOpportunity({ ...common, binding: null })).toMatchObject({
      ok: false,
      code: 'binding_unavailable'
    })
    expect(registry.size()).toBe(1)
  })
})
