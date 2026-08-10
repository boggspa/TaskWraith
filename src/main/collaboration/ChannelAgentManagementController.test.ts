import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'
import {
  ChannelAgentManagementController,
  type ChannelAgentManagementControllerDependencies,
  type ChannelAgentManagementControllerPort,
  type ChannelAgentManagementSeatInspection
} from './ChannelAgentManagementController'
import {
  hashChannelAgentNativeConfirmation,
  type ChannelAgentNativeConfirmationRequest
} from './ChannelAgentNativeConfirmation'
import type {
  ChannelProductionChannelView,
  ChannelProductionReadResult
} from './ChannelProductionService'

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() }
}))

const SEAT_ID = 'pooled-agent-controller-proof'
const OWNER = { isDestroyed: () => false } as BrowserWindow

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'participant-controller-proof',
    provider: 'codex',
    enabled: true,
    role: 'Review and implement',
    instructions: 'PRIVATE CONTROLLER INSTRUCTIONS MUST NOT LEAVE MAIN',
    order: 1,
    model: 'gpt-5.6-terra',
    permissionPresetId: 'full_access',
    pooledAgentId: SEAT_ID,
    pooledAgentIdentity: {
      schemaVersion: 1,
      agentId: SEAT_ID,
      nickname: 'Build Agent',
      iconKind: 'seed',
      hue: 120
    },
    ...overrides
  }
}

function chat(
  appChatId: string,
  workspaceId: string,
  participants: EnsembleParticipant[] = [participant()]
): ChatRecord {
  return {
    appChatId,
    title: `Chat ${appChatId}`,
    workspaceId,
    workspacePath: `/workspaces/${workspaceId}`,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    ensemble: { enabled: true, participants }
  } as ChatRecord
}

function channel(
  channelId: string,
  chatId: string,
  overrides: Partial<ChannelProductionChannelView> = {}
): ChannelProductionChannelView {
  return {
    channelId,
    chatId,
    ownerMemberId: `owner-${channelId}`,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    membershipRevision: 1,
    messageCount: 0,
    display: {
      title: `Channel ${channelId}`,
      status: 'active',
      memberCount: 3,
      messageCount: 0
    },
    availability: 'ready',
    ...overrides
  }
}

function humanMember(channelId: string, memberId: string, displayName: string, status = 'active') {
  return {
    channelId,
    memberId,
    kind: 'human' as const,
    displayName,
    status: status as 'active' | 'revoked',
    joinedAt: 1,
    ...(status === 'revoked' ? { revokedAt: 2 } : {})
  }
}

function agentMember(channelId: string, memberId: string, status = 'active') {
  return {
    channelId,
    memberId,
    kind: 'agent' as const,
    displayName: 'Build Agent',
    status: status as 'active' | 'revoked',
    joinedAt: 1,
    ...(status === 'revoked' ? { revokedAt: 2 } : {})
  }
}

function settings(): AppSettings {
  return {
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
  } as unknown as AppSettings
}

function inspection(
  memberships: ChannelAgentManagementSeatInspection['memberships'] = [
    {
      channelId: 'channel-1',
      memberId: 'agent-member-2',
      displayName: 'Build Agent',
      keyGeneration: 2,
      status: 'active'
    }
  ],
  currentKeyGeneration: number | null = 2
): ChannelAgentManagementSeatInspection {
  return { agentSeatId: SEAT_ID, currentKeyGeneration, memberships }
}

function serviceAgentMember(channelId: string, keyGeneration: number, status = 'active') {
  return {
    channelId,
    memberId: `agent-member-${keyGeneration}`,
    kind: 'agent' as const,
    displayName: 'Build Agent',
    identityPublicKey: 'public-key-must-not-project',
    status: status as 'active' | 'revoked',
    joinedAt: 1,
    agentSeatId: SEAT_ID,
    keyGeneration
  }
}

function enrollmentResult(channelId: string, keyGeneration: number) {
  return {
    member: serviceAgentMember(channelId, keyGeneration),
    identity: {
      agentSeatId: SEAT_ID,
      keyGeneration,
      publicKeyB64: 'public-key-must-not-project',
      createdAt: 1
    },
    signedDelegation: {
      delegation: { delegationId: 'delegation-must-not-project' },
      ownerSignatureB64: 'owner-signature-must-not-project'
    }
  }
}

function createHarness(
  options: {
    channels?: ChannelProductionChannelView[]
    chats?: ChatRecord[]
    inspection?: ChannelAgentManagementSeatInspection
    confirm?: ChannelAgentManagementControllerDependencies['confirm']
  } = {}
) {
  const channels = options.channels ?? [
    channel('channel-1', 'chat-1'),
    channel('channel-2', 'chat-2')
  ]
  const chats = options.chats ?? [chat('chat-1', 'workspace-1'), chat('chat-2', 'workspace-2')]
  let seatInspection = options.inspection ?? inspection()
  const reads = new Map<string, ChannelProductionReadResult>()
  for (const entry of channels) {
    const inspected = seatInspection.memberships.find(
      (membership) => membership.channelId === entry.channelId
    )
    reads.set(entry.channelId, {
      channel: entry,
      members: [
        humanMember(entry.channelId, entry.ownerMemberId, 'Owner'),
        humanMember(entry.channelId, `reviewer-${entry.channelId}`, 'Reviewer'),
        ...(inspected ? [agentMember(entry.channelId, inspected.memberId, inspected.status)] : [])
      ],
      pendingAdmissions: [],
      records: [],
      highWaterSequence: 0
    })
  }
  let currentSettings = settings()
  const enrollAgent = vi.fn(async ({ channelId }: { channelId: string; operationId: string }) =>
    enrollmentResult(channelId, seatInspection.currentKeyGeneration ?? 1)
  )
  const grantAgentDispatch = vi.fn(
    async (args: { channelId: string; ttlMs?: number; maxDispatches?: number }) => ({
      ...enrollmentResult(args.channelId, seatInspection.currentKeyGeneration ?? 1),
      signedDispatchGrant: {
        grant: {
          expiresAt: 10_000 + (args.ttlMs ?? 0),
          maxDispatches: args.maxDispatches ?? 0
        },
        ownerSignatureB64: 'grant-signature-must-not-project'
      }
    })
  )
  const revokeAgent = vi.fn(async ({ channelId }: { channelId: string }) => ({
    member: serviceAgentMember(
      channelId,
      seatInspection.memberships.find((member) => member.channelId === channelId)?.keyGeneration ??
        1,
      'revoked'
    ),
    signedRevocation: {
      revocation: { revocationId: 'revocation-must-not-project' },
      ownerSignatureB64: 'revocation-signature-must-not-project'
    },
    alreadyRevoked: false
  }))
  const rotateAgentKey = vi.fn(async () => {
    const next = (seatInspection.currentKeyGeneration ?? 0) + 1
    return {
      identity: {
        agentSeatId: SEAT_ID,
        keyGeneration: next,
        publicKeyB64: 'rotated-public-key-must-not-project',
        createdAt: 2
      },
      channels: seatInspection.memberships
        .filter((member) => member.status === 'active')
        .map((member) => enrollmentResult(member.channelId, next)),
      resumed: false
    }
  })
  const service = {
    listChannels: vi.fn(() => channels),
    readChannel: vi.fn(({ channelId }: { channelId: string }) => {
      const read = reads.get(channelId)
      if (!read) throw new Error('missing Channel read')
      return read
    }),
    inspectAgentSeat: vi.fn(() => seatInspection),
    inspectChannelAgentSeats: vi.fn((channelId: string) => {
      return seatInspection.memberships.some((member) => member.channelId === channelId)
        ? [seatInspection]
        : []
    }),
    enrollAgent,
    grantAgentDispatch,
    revokeAgent,
    rotateAgentKey
  } as unknown as ChannelAgentManagementControllerPort
  const confirm =
    options.confirm ??
    vi.fn(async (_owner, request) => ({
      confirmed: true as const,
      confirmationDigest: hashChannelAgentNativeConfirmation(request)
    }))
  const deps: ChannelAgentManagementControllerDependencies = {
    service,
    getChat: (chatId) => chats.find((entry) => entry.appChatId === chatId) ?? null,
    getSettings: () => currentSettings,
    providerAllowed: (provider) => provider === 'codex',
    resolveWorkspace: (record) =>
      record.workspaceId
        ? {
            principal: { kind: 'workspace', workspaceId: record.workspaceId },
            label: `Workspace ${record.workspaceId}`
          }
        : { principal: { kind: 'global', chatId: record.appChatId }, label: 'Global chat' },
    confirm
  }
  return {
    controller: new ChannelAgentManagementController(deps),
    channels,
    chats,
    reads,
    service,
    confirm,
    enrollAgent,
    grantAgentDispatch,
    revokeAgent,
    rotateAgentKey,
    setInspection: (value: ChannelAgentManagementSeatInspection) => {
      seatInspection = value
    },
    setSettings: (value: AppSettings) => {
      currentSettings = value
    }
  }
}

describe('ChannelAgentManagementController', () => {
  it('projects only eligible canonical seats, human mentioners, and bounded controls', () => {
    const harness = createHarness()

    const overview = harness.controller.describeChannel('channel-1')

    expect(overview).toMatchObject({
      channelId: 'channel-1',
      seats: [
        {
          seat: {
            agentSeatId: SEAT_ID,
            displayName: 'Build Agent',
            provider: 'codex',
            model: 'gpt-5.6-terra',
            role: 'Review and implement'
          },
          currentKeyGeneration: 2,
          membership: { memberId: 'agent-member-2', status: 'active' }
        }
      ],
      allowedMentioners: [
        { memberId: 'owner-channel-1', displayName: 'Owner' },
        { memberId: 'reviewer-channel-1', displayName: 'Reviewer' }
      ],
      grantLimits: {
        defaultTtlMs: 3_600_000,
        minimumTtlMs: 300_000,
        maximumDispatches: 100
      }
    })
    expect(JSON.stringify(overview)).not.toContain('PRIVATE CONTROLLER INSTRUCTIONS')
    expect(JSON.stringify(overview)).not.toContain('public-key')
  })

  it('derives a stable main operation id and projects no signed enrollment material', async () => {
    const harness = createHarness({ inspection: inspection([], null) })
    const input = {
      requestId: 'renderer-retry-token',
      channelId: 'channel-1',
      agentSeatId: SEAT_ID
    }

    const first = await harness.controller.enroll(OWNER, input)
    const second = await harness.controller.enroll(OWNER, input)

    expect(harness.enrollAgent).toHaveBeenCalledTimes(2)
    const firstOperationId = harness.enrollAgent.mock.calls[0][0].operationId
    expect(firstOperationId).toMatch(/^channel-agent-enroll-[a-f0-9]{64}$/)
    expect(firstOperationId).not.toContain(input.requestId)
    expect(harness.enrollAgent.mock.calls[1][0].operationId).toBe(firstOperationId)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      status: 'applied',
      value: {
        kind: 'enroll',
        agentSeatId: SEAT_ID,
        member: { channelId: 'channel-1', keyGeneration: 1, status: 'active' }
      }
    })
    expect(JSON.stringify(first)).not.toMatch(/signature|public-key|delegation/i)
  })

  it('defaults grants to the owner and signs only the freshly resolved hidden authority', async () => {
    const harness = createHarness()

    const outcome = await harness.controller.grant(OWNER, {
      requestId: 'grant-request-1',
      channelId: 'channel-1',
      agentSeatId: SEAT_ID,
      permissionPresetId: 'read_only'
    })

    const confirmed = (harness.confirm as ReturnType<typeof vi.fn>).mock.calls[0][1] as Extract<
      ChannelAgentNativeConfirmationRequest,
      { kind: 'grant' }
    >
    expect(confirmed).toMatchObject({
      kind: 'grant',
      allowedMentioners: [{ memberId: 'owner-channel-1', displayName: 'Owner' }],
      ttlMs: 3_600_000,
      maxDispatches: 1,
      authority: {
        permissionPresetId: 'read_only',
        approvalMode: 'plan',
        readOnly: true,
        workspaceLabel: 'Workspace workspace-1'
      }
    })
    expect(confirmed.authority.agenticServices.map((entry) => entry.serviceId)).toEqual(
      [...confirmed.authority.agenticServices].map((entry) => entry.serviceId).sort()
    )
    expect(harness.grantAgentDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentionerMemberIds: ['owner-channel-1'],
        workspaceIdentityHash: confirmed.authority.workspaceIdentityHash,
        permissionPostureHash: confirmed.authority.permissionPostureHash,
        ttlMs: 3_600_000,
        maxDispatches: 1
      })
    )
    expect(outcome).toMatchObject({
      status: 'applied',
      value: {
        kind: 'grant',
        allowedMentionerMemberIds: ['owner-channel-1'],
        permissionPresetId: 'read_only',
        maxDispatches: 1
      }
    })
    expect(JSON.stringify(outcome)).not.toMatch(
      /workspaceIdentityHash|permissionPostureHash|signature/i
    )
  })

  it('does not mutate after decline, forged decision digest, or post-click state drift', async () => {
    const declined = createHarness({ confirm: vi.fn(async () => ({ confirmed: false as const })) })
    await expect(
      declined.controller.revoke(OWNER, {
        requestId: 'revoke-declined',
        channelId: 'channel-1',
        agentSeatId: SEAT_ID
      })
    ).resolves.toEqual({ status: 'declined' })
    expect(declined.revokeAgent).not.toHaveBeenCalled()

    const forged = createHarness({
      confirm: vi.fn(async () => ({ confirmed: true as const, confirmationDigest: 'f'.repeat(64) }))
    })
    await expect(
      forged.controller.revoke(OWNER, {
        requestId: 'revoke-forged',
        channelId: 'channel-1',
        agentSeatId: SEAT_ID
      })
    ).resolves.toEqual({ status: 'stale' })
    expect(forged.revokeAgent).not.toHaveBeenCalled()

    const drift = createHarness()
    ;(drift.confirm as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_owner: BrowserWindow | null, request: ChannelAgentNativeConfirmationRequest) => {
        drift.channels[0] = {
          ...drift.channels[0],
          display: { ...drift.channels[0].display, title: 'Changed after click' }
        }
        return {
          confirmed: true as const,
          confirmationDigest: hashChannelAgentNativeConfirmation(request)
        }
      }
    )
    await expect(
      drift.controller.revoke(OWNER, {
        requestId: 'revoke-stale',
        channelId: 'channel-1',
        agentSeatId: SEAT_ID
      })
    ).resolves.toEqual({ status: 'stale' })
    expect(drift.revokeAgent).not.toHaveBeenCalled()
  })

  it('re-resolves hidden workspace and permission authority after the native click', async () => {
    const harness = createHarness()
    ;(harness.confirm as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_owner: BrowserWindow | null, request: ChannelAgentNativeConfirmationRequest) => {
        const changed = settings()
        changed.agenticServices.networkAccess = 'deny'
        harness.setSettings(changed)
        return {
          confirmed: true as const,
          confirmationDigest: hashChannelAgentNativeConfirmation(request)
        }
      }
    )

    await expect(
      harness.controller.grant(OWNER, {
        requestId: 'grant-hidden-drift',
        channelId: 'channel-1',
        agentSeatId: SEAT_ID,
        permissionPresetId: 'read_only'
      })
    ).resolves.toEqual({ status: 'stale' })
    expect(harness.grantAgentDispatch).not.toHaveBeenCalled()
  })

  it('keeps revocation available after roster removal and provider unavailability', async () => {
    const harness = createHarness({ chats: [chat('chat-1', 'workspace-1', [])] })

    expect(harness.controller.describeChannel('channel-1').seats).toEqual([
      expect.objectContaining({
        seat: {
          agentSeatId: SEAT_ID,
          displayName: 'Build Agent',
          provider: null,
          model: null,
          role: null
        },
        membership: expect.objectContaining({ memberId: 'agent-member-2', status: 'active' })
      })
    ])

    const outcome = await harness.controller.revoke(OWNER, {
      requestId: 'revoke-orphaned-seat',
      channelId: 'channel-1',
      agentSeatId: SEAT_ID
    })

    const request = (harness.confirm as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(request).toMatchObject({
      kind: 'revoke',
      seat: {
        agentSeatId: SEAT_ID,
        displayName: 'Build Agent',
        provider: null,
        model: null,
        role: null
      },
      agentMemberId: 'agent-member-2',
      keyGeneration: 2
    })
    expect(outcome).toMatchObject({ status: 'applied', value: { kind: 'revoke' } })
  })

  it('confirms every active rotation target and an explicit revoked re-enrollment target', async () => {
    const seatState = inspection([
      {
        channelId: 'channel-1',
        memberId: 'agent-member-2',
        displayName: 'Build Agent',
        keyGeneration: 2,
        status: 'active'
      },
      {
        channelId: 'channel-2',
        memberId: 'agent-member-2-channel-2',
        displayName: 'Build Agent',
        keyGeneration: 2,
        status: 'revoked'
      }
    ])
    const harness = createHarness({ inspection: seatState })

    const outcome = await harness.controller.rotate(OWNER, {
      requestId: 'rotate-request-1',
      channelId: 'channel-1',
      agentSeatId: SEAT_ID,
      reEnrollChannelIds: ['channel-2']
    })

    const request = (harness.confirm as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(request).toMatchObject({
      kind: 'rotate',
      fromKeyGeneration: 2,
      toKeyGeneration: 3,
      channels: [
        { channelId: 'channel-1', channelTitle: 'Channel channel-1' },
        { channelId: 'channel-2', channelTitle: 'Channel channel-2' }
      ]
    })
    expect(harness.rotateAgentKey).toHaveBeenCalledWith(
      expect.objectContaining({ reEnrollChannelIds: ['channel-2'] })
    )
    expect(outcome).toMatchObject({
      status: 'applied',
      value: { kind: 'rotate', fromKeyGeneration: 2, toKeyGeneration: 3 }
    })
    expect(JSON.stringify(outcome)).not.toMatch(/public-key|delegation|signature/i)
  })

  it('fails closed on wrong workspace authority, unknown fields, and recovery-blocked rotation', async () => {
    const harness = createHarness()
    const wrongWorkspace = new ChannelAgentManagementController({
      service: harness.service,
      getChat: (chatId) => harness.chats.find((entry) => entry.appChatId === chatId) ?? null,
      getSettings: settings,
      providerAllowed: () => true,
      resolveWorkspace: () => ({
        principal: { kind: 'workspace', workspaceId: 'workspace-swapped' },
        label: 'Swapped workspace'
      }),
      confirm: harness.confirm
    })
    await expect(
      wrongWorkspace.grant(OWNER, {
        requestId: 'grant-wrong-workspace',
        channelId: 'channel-1',
        agentSeatId: SEAT_ID,
        permissionPresetId: 'read_only'
      })
    ).rejects.toThrow(/workspace principal is unavailable/)

    expect(() =>
      harness.controller.enroll(OWNER, {
        requestId: 'enroll-extra-field',
        channelId: 'channel-1',
        agentSeatId: SEAT_ID,
        surprise: true
      } as never)
    ).toThrow(/unknown field/)

    harness.channels[1].availability = 'recovery_blocked'
    harness.setInspection(
      inspection([
        ...inspection().memberships,
        {
          channelId: 'channel-2',
          memberId: 'agent-member-blocked',
          displayName: 'Build Agent',
          keyGeneration: 2,
          status: 'revoked'
        }
      ])
    )
    await expect(
      harness.controller.rotate(OWNER, {
        requestId: 'rotate-blocked',
        channelId: 'channel-1',
        agentSeatId: SEAT_ID
      })
    ).rejects.toThrow(/recovery-blocked Channel/)
    expect(harness.rotateAgentKey).not.toHaveBeenCalled()
  })
})
