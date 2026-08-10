import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { PROVIDER_RUN_MANAGEMENT_IDS } from '../run/ProviderRunManagementMatrix'
import {
  buildChannelAgentNativeConfirmationOptions,
  confirmChannelAgentManagement,
  hashChannelAgentNativeConfirmation,
  type ChannelAgentNativeConfirmationRequest,
  type ChannelAgentNativeGrantRequest
} from './ChannelAgentNativeConfirmation'

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() }
}))

const WORKSPACE_HASH = 'a'.repeat(64)
const POSTURE_HASH = 'b'.repeat(64)

function seat() {
  return {
    agentSeatId: 'pooled-agent-native-proof',
    displayName: 'Build Agent',
    provider: 'codex' as const,
    model: 'gpt-5.6-terra',
    role: 'Review and implement'
  }
}

function grant(
  overrides: Partial<ChannelAgentNativeGrantRequest> = {}
): ChannelAgentNativeGrantRequest {
  return {
    kind: 'grant',
    operationId: 'grant-operation-1',
    channelId: 'channel-1',
    channelTitle: 'Release room',
    seat: seat(),
    agentMemberId: 'agent-member-1',
    keyGeneration: 2,
    allowedMentioners: [
      { memberId: 'human-a', displayName: 'Owner' },
      { memberId: 'human-b', displayName: 'Reviewer' }
    ],
    authority: {
      permissionPresetId: 'workspace_write',
      approvalMode: 'auto_edit',
      readOnly: false,
      networkAccess: 'deny',
      agenticServices: [
        { serviceId: 'fileChanges', policy: 'allow' },
        { serviceId: 'shellCommands', policy: 'ask' }
      ],
      externalPathGrants: [
        {
          path: '/external/project',
          kind: 'directory',
          access: 'write',
          duration: 'thisThread'
        }
      ],
      workspaceLabel: 'Workspace “TaskWraith”',
      workspaceIdentityHash: WORKSPACE_HASH,
      permissionPostureHash: POSTURE_HASH
    },
    ttlMs: 60 * 60 * 1_000,
    maxDispatches: 2,
    ...overrides
  }
}

describe('ChannelAgentNativeConfirmation', () => {
  it('recognizes every managed provider without treating recognition as admission', () => {
    for (const provider of PROVIDER_RUN_MANAGEMENT_IDS) {
      const options = buildChannelAgentNativeConfirmationOptions(
        grant({ seat: { ...seat(), provider, model: `${provider}-proof-model` } })
      )
      expect(options.detail).toContain(`Provider/model: ${provider} / ${provider}-proof-model`)
    }
  })

  it('shows the exact human-readable grant authority without rendering hidden hashes', () => {
    const options = buildChannelAgentNativeConfirmationOptions(grant())

    expect(options).toMatchObject({
      title: 'Authorize Channel Agent',
      message: 'Allow Build Agent to run from Channel mentions?',
      confirmLabel: 'Authorize Mentions'
    })
    expect(options.detail).toContain('Stable seat: pooled-agent-native-proof')
    expect(options.detail).toContain('Provider/model: codex / gpt-5.6-terra')
    expect(options.detail).toContain(
      'Allowed human mentioners: Owner [human-a], Reviewer [human-b]'
    )
    expect(options.detail).toContain(
      'Permission: workspace_write; approval=auto_edit; read-only=no; network=deny'
    )
    expect(options.detail).toContain('fileChanges=allow, shellCommands=ask')
    expect(options.detail).toContain('write directory: /external/project (thisThread)')
    expect(options.detail).toContain('Lifetime: 1 hour')
    expect(options.detail).toContain('Budget: 2 automatic dispatches')
    expect(options.detail).not.toContain(WORKSPACE_HASH)
    expect(options.detail).not.toContain(POSTURE_HASH)
    expect(options.detail).not.toContain('grant-operation-1')
  })

  it('binds hidden hashes and operation identity into a deterministic domain-separated digest', () => {
    const base = grant()
    const same = grant()
    const anotherWorkspace = grant({
      authority: { ...base.authority, workspaceIdentityHash: 'c'.repeat(64) }
    })
    const anotherOperation = grant({ operationId: 'grant-operation-2' })

    expect(hashChannelAgentNativeConfirmation(base)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashChannelAgentNativeConfirmation(same)).toBe(hashChannelAgentNativeConfirmation(base))
    expect(hashChannelAgentNativeConfirmation(anotherWorkspace)).not.toBe(
      hashChannelAgentNativeConfirmation(base)
    )
    expect(hashChannelAgentNativeConfirmation(anotherOperation)).not.toBe(
      hashChannelAgentNativeConfirmation(base)
    )
  })

  it('describes enrollment, revocation, and global rotation as distinct authority changes', () => {
    const enroll = buildChannelAgentNativeConfirmationOptions({
      kind: 'enroll',
      operationId: 'enroll-1',
      channelId: 'channel-1',
      channelTitle: 'Release room',
      seat: seat(),
      existingKeyGeneration: null
    })
    const revoke = buildChannelAgentNativeConfirmationOptions({
      kind: 'revoke',
      operationId: 'revoke-1',
      channelId: 'channel-1',
      channelTitle: 'Release room',
      seat: seat(),
      agentMemberId: 'agent-member-1',
      keyGeneration: 1
    })
    const rotate = buildChannelAgentNativeConfirmationOptions({
      kind: 'rotate',
      operationId: 'rotate-1',
      seat: seat(),
      fromKeyGeneration: 1,
      toKeyGeneration: 2,
      channels: [
        { channelId: 'channel-1', channelTitle: 'Release room' },
        { channelId: 'channel-2', channelTitle: 'Review room' }
      ]
    })

    expect(enroll.detail).toContain('Enrollment alone does not authorize automatic runs')
    expect(revoke.detail).toContain('persist key revocation before removing membership')
    expect(rotate.detail).toContain('Key generation: 1 → 2')
    expect(rotate.detail).toContain('old mention grants remain revoked')
  })

  it('keeps destructive cleanup confirmable after mutable seat descriptors disappear', () => {
    const unavailableSeat = {
      agentSeatId: 'pooled-agent-native-proof',
      displayName: 'Build Agent',
      provider: null,
      model: null,
      role: null
    } as const
    const revoke = buildChannelAgentNativeConfirmationOptions({
      kind: 'revoke',
      operationId: 'revoke-unavailable-1',
      channelId: 'channel-1',
      channelTitle: 'Release room',
      seat: unavailableSeat,
      agentMemberId: 'agent-member-1',
      keyGeneration: 1
    })
    const rotate = buildChannelAgentNativeConfirmationOptions({
      kind: 'rotate',
      operationId: 'rotate-unavailable-1',
      seat: unavailableSeat,
      fromKeyGeneration: 1,
      toKeyGeneration: 2,
      channels: [{ channelId: 'channel-1', channelTitle: 'Release room' }]
    })

    expect(revoke.detail).toContain(
      'Provider/model/role: unavailable (cleanup uses the durable signed seat binding)'
    )
    expect(rotate.detail).toContain('Key generation: 1 → 2')
    expect(() =>
      buildChannelAgentNativeConfirmationOptions(grant({ seat: unavailableSeat }))
    ).toThrow(/request is invalid/)
    expect(() =>
      buildChannelAgentNativeConfirmationOptions({
        kind: 'enroll',
        operationId: 'enroll-unavailable-1',
        channelId: 'channel-1',
        channelTitle: 'Release room',
        seat: unavailableSeat,
        existingKeyGeneration: null
      })
    ).toThrow(/request is invalid/)
  })

  it('strips control and bidi spoofing from every renderer-visible label', () => {
    const request = grant({
      channelTitle: 'Release\n\u202eFull Access',
      seat: {
        ...seat(),
        agentSeatId: 'pooled-agent-proof\u202eadmin',
        displayName: 'Build\u2066 Agent',
        model: 'gpt\u0000fake',
        role: 'Review\u061c role'
      },
      authority: {
        ...grant().authority,
        workspaceLabel: 'Workspace\u200f\nFull Access'
      }
    })
    const options = buildChannelAgentNativeConfirmationOptions(request)

    expect(options.detail).toContain('Channel: Release Full Access [channel-1]')
    for (const control of ['\u0000', '\u061c', '\u200f', '\u202e', '\u2066']) {
      expect(options.message.includes(control)).toBe(false)
      expect(options.detail.includes(control)).toBe(false)
    }
  })

  it('rejects non-canonical sets, unknown fields, and malformed authority before prompting', () => {
    expect(() =>
      buildChannelAgentNativeConfirmationOptions(
        grant({ allowedMentioners: [...grant().allowedMentioners].reverse() })
      )
    ).toThrow(/request is invalid/)
    expect(() =>
      buildChannelAgentNativeConfirmationOptions({
        ...grant(),
        surprise: 'hidden authority'
      } as unknown as ChannelAgentNativeConfirmationRequest)
    ).toThrow(/request is invalid/)
    expect(() =>
      buildChannelAgentNativeConfirmationOptions(
        grant({ authority: { ...grant().authority, permissionPostureHash: 'not-a-hash' } })
      )
    ).toThrow(/request is invalid/)
  })

  it('fails closed without a live owner or when the native dialog fails', async () => {
    const confirm = vi.fn(async () => true)
    await expect(confirmChannelAgentManagement(null, grant(), { confirm })).resolves.toEqual({
      confirmed: false
    })
    await expect(
      confirmChannelAgentManagement({ isDestroyed: () => true } as BrowserWindow, grant(), {
        confirm
      })
    ).resolves.toEqual({ confirmed: false })
    expect(confirm).not.toHaveBeenCalled()

    const owner = { isDestroyed: () => false } as BrowserWindow
    await expect(
      confirmChannelAgentManagement(owner, grant(), {
        confirm: async () => {
          throw new Error('dialog unavailable')
        }
      })
    ).resolves.toEqual({ confirmed: false })
  })

  it('returns only the exact pre-dialog digest after an affirmative native decision', async () => {
    const owner = { isDestroyed: () => false } as BrowserWindow
    const confirm = vi.fn(async () => true)
    const request = grant()
    const expectedDigest = hashChannelAgentNativeConfirmation(request)

    await expect(confirmChannelAgentManagement(owner, request, { confirm })).resolves.toEqual({
      confirmed: true,
      confirmationDigest: expectedDigest
    })
    expect(confirm).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ confirmLabel: 'Authorize Mentions' })
    )
  })
})
