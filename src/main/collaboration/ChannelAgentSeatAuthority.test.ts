import { describe, expect, it } from 'vitest'
import { PROVIDER_RUN_MANAGEMENT_IDS } from '../run/ProviderRunManagementMatrix'
import type { AppSettings, ChatRecord, EnsembleParticipant, ProviderId } from '../store/types'
import {
  hashChannelAgentWorkspacePrincipal,
  listChannelAgentSeatCandidates,
  resolveChannelAgentGrantAuthority,
  resolveChannelAgentSeat
} from './ChannelAgentSeatAuthority'

const settings = {
  agenticServices: {
    shellCommands: 'ask',
    fileChanges: 'ask',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    canvasEval: 'ask',
    networkAccess: 'allow'
  },
  agenticWorkspaceGrants: []
} as Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>

function participant(
  id: string,
  agentSeatId: string,
  overrides: Partial<EnsembleParticipant> = {}
): EnsembleParticipant {
  return {
    id,
    provider: 'codex',
    enabled: true,
    role: 'Review changes',
    instructions: 'Inspect the current workspace.',
    order: 1,
    model: 'gpt-5.6-terra',
    permissionPresetId: 'full_access',
    permissionOverrides: {
      approvalMode: 'auto_edit',
      networkAccess: 'allow'
    },
    pooledAgentId: agentSeatId,
    pooledAgentIdentity: {
      schemaVersion: 1,
      agentId: agentSeatId,
      nickname: 'Build Agent',
      iconKind: 'seed',
      hue: 120
    },
    ...overrides
  }
}

function chat(
  participants: EnsembleParticipant[],
  overrides: Partial<ChatRecord> = {}
): ChatRecord {
  return {
    appChatId: 'chat-seat-authority',
    title: 'Seat authority proof',
    workspaceId: 'workspace-canonical',
    workspacePath: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    ensemble: {
      enabled: true,
      participants
    },
    ...overrides
  } as ChatRecord
}

const allowAll = (_provider: ProviderId): boolean => true

describe('ChannelAgentSeatAuthority', () => {
  it('lists only unique enabled pooled seats from the canonical chat snapshot', () => {
    const duplicateSeat = 'pooled-agent-duplicate'
    const validSeat = 'pooled-agent-valid'
    const candidates = listChannelAgentSeatCandidates(
      chat([
        participant('participant-valid', validSeat, {
          pooledAgentIdentity: {
            schemaVersion: 1,
            agentId: validSeat,
            nickname: '  Build\u202e Agent  ',
            iconKind: 'seed',
            hue: 120
          }
        }),
        participant('participant-duplicate-a', duplicateSeat),
        participant('participant-duplicate-b', duplicateSeat, { order: 2 }),
        participant('participant-disabled', 'pooled-agent-disabled', { enabled: false }),
        participant('participant-mismatch', 'pooled-agent-mismatch', {
          pooledAgentIdentity: {
            schemaVersion: 1,
            agentId: 'pooled-agent-another',
            nickname: 'Mismatch',
            iconKind: 'seed',
            hue: 1
          }
        })
      ]),
      allowAll
    )

    expect(candidates).toEqual([
      expect.objectContaining({
        agentSeatId: validSeat,
        participantId: 'participant-valid',
        displayName: 'Build Agent',
        provider: 'codex',
        configuredPermissionPresetId: 'full_access'
      })
    ])
    expect(resolveChannelAgentSeat(chat([]), validSeat, allowAll)).toBeNull()
  })

  it('rejects renderer-only, malformed, unavailable-provider, and ambiguous seats', () => {
    const seat = 'pooled-agent-proof'
    const canonical = chat([participant('participant-a', seat)])

    expect(resolveChannelAgentSeat(canonical, 'pooled-agent-renderer-only', allowAll)).toBeNull()
    expect(resolveChannelAgentSeat(canonical, 'not-a-pooled-seat', allowAll)).toBeNull()
    expect(resolveChannelAgentSeat(canonical, seat, () => false)).toBeNull()
    expect(
      resolveChannelAgentSeat(
        chat([
          participant('participant-a', seat),
          participant('participant-b', seat, { order: 2 })
        ]),
        seat,
        allowAll
      )
    ).toBeNull()
  })

  it('recognizes every canonical run-management provider before the independent admission gate', () => {
    const candidates = listChannelAgentSeatCandidates(
      chat(
        PROVIDER_RUN_MANAGEMENT_IDS.map((provider, index) =>
          participant(`participant-${provider}`, `pooled-agent-${provider}`, {
            provider,
            order: index + 1
          })
        )
      ),
      allowAll
    )

    expect(candidates.map((candidate) => candidate.provider).sort()).toEqual(
      [...PROVIDER_RUN_MANAGEMENT_IDS].sort()
    )
    expect(candidates.map((candidate) => candidate.provider)).toContain('muse')
  })

  it('fails closed on malformed persisted identity and runtime fields', () => {
    const malformed = [
      participant('participant-bad-icon', 'pooled-agent-bad-icon', {
        pooledAgentIdentity: {
          schemaVersion: 1,
          agentId: 'pooled-agent-bad-icon',
          nickname: 'Bad icon',
          iconKind: 'unknown' as 'seed',
          hue: 1
        }
      }),
      participant('participant-bad-model', 'pooled-agent-bad-model', { model: '\0model' }),
      participant('participant-bad-permission', 'pooled-agent-bad-permission', {
        permissionPresetId: 'owner' as 'default'
      }),
      participant('participant-bad-toggle', 'pooled-agent-bad-toggle', {
        fastModeEnabled: 'yes' as unknown as boolean
      }),
      participant('participant-bad-instructions', 'pooled-agent-bad-instructions', {
        instructions: 'x'.repeat(64 * 1024 + 1)
      })
    ]

    expect(listChannelAgentSeatCandidates(chat(malformed), allowAll)).toEqual([])
  })

  it('domain-separates workspace and global principals without projecting raw ids', () => {
    const workspaceHash = hashChannelAgentWorkspacePrincipal({
      kind: 'workspace',
      workspaceId: 'workspace-canonical'
    })
    const globalHash = hashChannelAgentWorkspacePrincipal({
      kind: 'global',
      chatId: 'chat-seat-authority'
    })

    expect(workspaceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(globalHash).toMatch(/^[a-f0-9]{64}$/)
    expect(workspaceHash).not.toBe(globalHash)
    expect(workspaceHash).not.toContain('workspace-canonical')
    expect(() =>
      hashChannelAgentWorkspacePrincipal({ kind: 'workspace', workspaceId: ' bad ' })
    ).toThrow(/principal is invalid/)
  })

  it('derives a selected read-only posture without participant override widening', () => {
    const seat = 'pooled-agent-read-only'
    const resolved = resolveChannelAgentGrantAuthority({
      chat: chat([participant('participant-read-only', seat)]),
      agentSeatId: seat,
      permissionPresetId: 'read_only',
      workspacePrincipal: { kind: 'workspace', workspaceId: 'workspace-canonical' },
      settings,
      providerAllowed: allowAll
    })

    expect(resolved).toMatchObject({
      seat: { agentSeatId: seat, provider: 'codex' },
      permissionPresetId: 'read_only',
      effectivePermissions: {
        presetId: 'read_only',
        approvalMode: 'plan',
        readOnly: true
      }
    })
    expect(resolved.workspaceIdentityHash).toMatch(/^[a-f0-9]{64}$/)
    expect(resolved.permissionPostureHash).toMatch(/^[a-f0-9]{64}$/)
    expect(resolved.effectivePermissions.approvalMode).not.toBe('auto_edit')
  })

  it('changes authority hashes when the main-resolved principal or effective posture changes', () => {
    const seat = 'pooled-agent-hash-binding'
    const canonical = chat([participant('participant-hash', seat)], {
      workspaceId: 'workspace-a'
    })
    const base = resolveChannelAgentGrantAuthority({
      chat: canonical,
      agentSeatId: seat,
      permissionPresetId: 'read_only',
      workspacePrincipal: { kind: 'workspace', workspaceId: 'workspace-a' },
      settings,
      providerAllowed: allowAll
    })
    const anotherWorkspace = resolveChannelAgentGrantAuthority({
      chat: { ...canonical, workspaceId: 'workspace-b' },
      agentSeatId: seat,
      permissionPresetId: 'read_only',
      workspacePrincipal: { kind: 'workspace', workspaceId: 'workspace-b' },
      settings,
      providerAllowed: allowAll
    })
    const writeCapable = resolveChannelAgentGrantAuthority({
      chat: canonical,
      agentSeatId: seat,
      permissionPresetId: 'workspace_write',
      workspacePrincipal: { kind: 'workspace', workspaceId: 'workspace-a' },
      settings,
      providerAllowed: allowAll
    })

    expect(anotherWorkspace.workspaceIdentityHash).not.toBe(base.workspaceIdentityHash)
    expect(anotherWorkspace.permissionPostureHash).toBe(base.permissionPostureHash)
    expect(writeCapable.permissionPostureHash).not.toBe(base.permissionPostureHash)
  })

  it('requires the main-resolved principal kind to match the chat scope', () => {
    const seat = 'pooled-agent-global'
    const globalChat = chat([participant('participant-global', seat)], {
      scope: 'global',
      workspaceId: undefined,
      workspacePath: undefined
    })

    expect(() =>
      resolveChannelAgentGrantAuthority({
        chat: globalChat,
        agentSeatId: seat,
        permissionPresetId: 'read_only',
        workspacePrincipal: { kind: 'workspace', workspaceId: 'workspace-a' },
        settings,
        providerAllowed: allowAll
      })
    ).toThrow(/global principal does not match/)
    expect(
      resolveChannelAgentGrantAuthority({
        chat: globalChat,
        agentSeatId: seat,
        permissionPresetId: 'read_only',
        workspacePrincipal: { kind: 'global', chatId: globalChat.appChatId },
        settings,
        providerAllowed: allowAll
      }).workspaceIdentityHash
    ).toMatch(/^[a-f0-9]{64}$/)

    const workspaceChat = chat([participant('participant-workspace', seat)])
    expect(() =>
      resolveChannelAgentGrantAuthority({
        chat: workspaceChat,
        agentSeatId: seat,
        permissionPresetId: 'read_only',
        workspacePrincipal: { kind: 'workspace', workspaceId: 'workspace-swapped' },
        settings,
        providerAllowed: allowAll
      })
    ).toThrow(/workspace principal is unavailable/)
  })
})
