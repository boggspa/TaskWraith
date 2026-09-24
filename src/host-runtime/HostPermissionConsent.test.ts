import { describe, expect, it } from 'vitest'

import {
  HostFullAccessGrantRegistry,
  HostPermissionConsentAuthority,
  createHostPermissionConsentProof,
  type HostPermissionConsentIssueInput
} from './HostPermissionConsent'

const ACKNOWLEDGED_AT = '2026-08-29T23:30:00.000Z'

/**
 * The authority validates the binding's workspace path with the ambient
 * platform's absolute-path rules, so the fixture must be canonical on the
 * runner's OS.
 */
const WORKSPACE_PATH =
  process.platform === 'win32'
    ? 'C:\\taskwraith-consent-workspace'
    : '/tmp/taskwraith-consent-workspace'

function binding(overrides: Partial<HostPermissionConsentIssueInput> = {}) {
  return {
    commandId: '11111111-1111-4111-8111-111111111111',
    commandFingerprint: 'a'.repeat(64),
    actor: { actorId: 'tui-user', clientId: 'tui-client', clientClass: 'tui' as const },
    threadId: 'thread-1',
    providerId: 'codex',
    workspaceId: 'workspace-1',
    workspacePath: WORKSPACE_PATH,
    modelId: 'gpt-5.6-terra',
    postureId: 'full_access' as const,
    offerRevision: 'offer-revision-1',
    issuedAt: '2026-08-29T23:29:59.000Z',
    ...overrides
  }
}

describe('HostPermissionConsentAuthority', () => {
  it('verifies only the exact signed thread/provider/workspace/model/posture offer binding', () => {
    const proofSecret = Buffer.alloc(32, 7)
    const authority = new HostPermissionConsentAuthority(
      proofSecret,
      () => ACKNOWLEDGED_AT,
      Buffer.alloc(32, 1)
    )
    const input = binding()
    const envelope = authority.issue(input)
    const expected = {
      threadId: input.threadId,
      providerId: input.providerId,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      modelId: input.modelId,
      postureId: input.postureId,
      offerRevision: input.offerRevision
    }

    expect(authority.verify(envelope, expected)).toMatchObject({
      commandId: input.commandId,
      actor: input.actor,
      acknowledgedAt: ACKNOWLEDGED_AT
    })
    for (const mutation of [
      { threadId: 'thread-2' },
      { providerId: 'claude' },
      { workspaceId: 'workspace-2' },
      { workspacePath: '/tmp/other-workspace' },
      { modelId: 'gpt-5.6-sol' },
      { postureId: 'workspace_write' as const },
      { offerRevision: 'offer-revision-2' }
    ]) {
      expect(authority.verify(envelope, { ...expected, ...mutation })).toBeNull()
    }
    expect(
      authority.verify(
        {
          ...envelope,
          provenance: { ...envelope.provenance, modelId: 'gpt-5.6-sol' }
        },
        { ...expected, modelId: 'gpt-5.6-sol' }
      )
    ).toBeNull()
    expect(
      new HostPermissionConsentAuthority(Buffer.alloc(32, 8)).verify(envelope, expected)
    ).toBeNull()
    const launchClientForgery = new HostPermissionConsentAuthority(
      proofSecret,
      () => ACKNOWLEDGED_AT,
      Buffer.alloc(32, 2)
    ).issue(input)
    expect(authority.verify(launchClientForgery, expected)).toBeNull()
  })

  it('requires the process-ephemeral launch proof and never projects its secret', () => {
    const secret = Buffer.alloc(32, 9)
    const secretHex = secret.toString('hex')
    const authority = new HostPermissionConsentAuthority(secret, () => ACKNOWLEDGED_AT)
    const input = binding()
    const proofRequest = {
      commandId: input.commandId,
      actor: input.actor,
      threadId: input.threadId,
      providerId: input.providerId,
      modelId: input.modelId,
      postureId: input.postureId,
      offerRevision: input.offerRevision,
      issuedAt: input.issuedAt
    }
    const proof = createHostPermissionConsentProof(secret, proofRequest)
    expect(authority.verifyRequestProof(proofRequest, proof)).toBe(true)
    expect(authority.verifyRequestProof(proofRequest, proof)).toBe(false)
    expect(authority.verifyRequestProof({ ...proofRequest, threadId: 'thread-2' }, proof)).toBe(
      false
    )
    expect(
      new HostPermissionConsentAuthority(Buffer.alloc(32, 8)).verifyRequestProof(
        proofRequest,
        proof
      )
    ).toBe(false)

    const envelope = authority.issue(input)
    const projected = JSON.stringify(envelope)
    expect(projected).not.toContain(secretHex)
    expect(projected).not.toMatch(/effectivePermissions|agenticServices|shellCommands|apiKey/i)
    authority.dispose()
  })

  it('requires a live exact grant and cannot revive one from copied profile metadata', () => {
    const authority = new HostPermissionConsentAuthority(Buffer.alloc(32, 2), () => ACKNOWLEDGED_AT)
    const input = binding()
    const envelope = authority.issue(input)
    const expected = {
      threadId: input.threadId,
      providerId: input.providerId,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      modelId: input.modelId,
      postureId: input.postureId,
      offerRevision: input.offerRevision
    }
    const verified = authority.verify(envelope, expected)!
    const grants = new HostFullAccessGrantRegistry()
    expect(grants.matches(envelope, verified, expected)).toBe(false)
    grants.activateVerified(envelope, verified)
    expect(grants.matches(envelope, verified, expected)).toBe(true)
    grants.revokeThread(input.threadId)
    expect(grants.matches(envelope, verified, expected)).toBe(false)
    expect(new HostFullAccessGrantRegistry().matches(envelope, verified, expected)).toBe(false)
  })

  it('rejects stale or future-dated configure proof provenance', () => {
    const authority = new HostPermissionConsentAuthority(Buffer.alloc(32, 3), () => ACKNOWLEDGED_AT)
    expect(() => authority.issue(binding({ issuedAt: '2026-08-29T23:20:00.000Z' }))).toThrow(
      /binding is invalid/i
    )
    expect(() => authority.issue(binding({ issuedAt: '2026-08-29T23:31:00.000Z' }))).toThrow(
      /binding is invalid/i
    )
  })

  it('zeroizes live authority and refuses use after disposal', () => {
    const authority = new HostPermissionConsentAuthority(Buffer.alloc(32, 4), () => ACKNOWLEDGED_AT)
    const envelope = authority.issue(binding())
    authority.dispose()
    expect(() => authority.issue(binding())).toThrow(/disposed/i)
    expect(
      authority.verify(envelope, {
        threadId: 'thread-1',
        providerId: 'codex',
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/taskwraith-consent-workspace',
        modelId: 'gpt-5.6-terra',
        postureId: 'full_access',
        offerRevision: 'offer-revision-1'
      })
    ).toBeNull()
  })
})
