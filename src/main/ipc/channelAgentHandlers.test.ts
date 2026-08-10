import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_AGENT_IPC_CHANNELS,
  type ChannelAgentIpcResult
} from '../../shared/collaboration/ChannelAgentIpc'
import type {
  ChannelAgentManagementController,
  ChannelAgentManagementOutcome,
  ChannelAgentManagementOverview
} from '../collaboration/ChannelAgentManagementController'
import { ChannelAgentManagementError } from '../collaboration/ChannelAgentManagementService'
import { ChannelError } from '../collaboration/ChannelStore'
import { registerChannelAgentHandlers } from './channelAgentHandlers'

type Handler = (event: IpcMainInvokeEvent, value?: unknown) => unknown

const EVENT = { sender: { id: 7 } } as IpcMainInvokeEvent
const OWNER = { isDestroyed: () => false } as BrowserWindow
const BASE_INPUT = {
  requestId: 'renderer-request-1',
  channelId: 'channel-1',
  agentSeatId: 'pooled-agent-handler-proof'
}

function overview() {
  return {
    channelId: 'channel-1',
    seats: [
      {
        seat: {
          agentSeatId: BASE_INPUT.agentSeatId,
          displayName: 'Build Agent',
          provider: 'codex' as const,
          model: 'gpt-5.6-terra',
          role: 'Review changes',
          instructions: 'must-not-cross-ipc'
        },
        currentKeyGeneration: 2,
        membership: {
          channelId: 'channel-1',
          memberId: 'agent-member-2',
          displayName: 'Build Agent',
          keyGeneration: 2,
          status: 'active' as const,
          publicKeyB64: 'must-not-cross-ipc'
        }
      }
    ],
    allowedMentioners: [{ memberId: 'owner-member', displayName: 'Owner' }],
    permissionPresetIds: ['read_only', 'workspace_write'] as const,
    grantLimits: {
      defaultTtlMs: 3_600_000,
      minimumTtlMs: 300_000,
      maximumTtlMs: 2_592_000_000,
      defaultMaxDispatches: 1,
      maximumDispatches: 100
    },
    workspaceIdentityHash: 'a'.repeat(64)
  }
}

function member(status: 'active' | 'revoked' = 'active') {
  return {
    channelId: 'channel-1',
    memberId: 'agent-member-2',
    status,
    keyGeneration: 2,
    identityPublicKey: 'must-not-cross-ipc'
  }
}

function fixture(options: { main?: boolean; owner?: BrowserWindow | null } = {}) {
  const handlers = new Map<string, Handler>()
  const removeHandler = vi.fn((channel: string) => handlers.delete(channel))
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>
  const controller = {
    describeChannel: vi.fn((): ChannelAgentManagementOverview => overview()),
    enroll: vi.fn(
      async (): Promise<ChannelAgentManagementOutcome> => ({
        status: 'applied' as const,
        value: Object.assign(
          {
            kind: 'enroll' as const,
            agentSeatId: BASE_INPUT.agentSeatId,
            member: member()
          },
          {
            signedDelegation: 'must-not-cross-ipc'
          }
        )
      })
    ),
    grant: vi.fn(
      async (): Promise<ChannelAgentManagementOutcome> => ({
        status: 'applied' as const,
        value: Object.assign(
          {
            kind: 'grant' as const,
            agentSeatId: BASE_INPUT.agentSeatId,
            member: member(),
            allowedMentionerMemberIds: ['owner-member', 'reviewer-member'],
            permissionPresetId: 'read_only' as const,
            expiresAt: 123_456,
            maxDispatches: 2
          },
          {
            permissionPostureHash: 'b'.repeat(64)
          }
        )
      })
    ),
    revoke: vi.fn(
      async (): Promise<ChannelAgentManagementOutcome> => ({
        status: 'applied' as const,
        value: Object.assign(
          {
            kind: 'revoke' as const,
            agentSeatId: BASE_INPUT.agentSeatId,
            member: member('revoked'),
            alreadyRevoked: false
          },
          {
            signedRevocation: 'must-not-cross-ipc'
          }
        )
      })
    ),
    rotate: vi.fn(
      async (): Promise<ChannelAgentManagementOutcome> => ({
        status: 'applied' as const,
        value: Object.assign(
          {
            kind: 'rotate' as const,
            agentSeatId: BASE_INPUT.agentSeatId,
            fromKeyGeneration: 2,
            toKeyGeneration: 3,
            members: [{ ...member(), keyGeneration: 3 }],
            resumed: false
          },
          {
            publicKeyB64: 'must-not-cross-ipc'
          }
        )
      })
    )
  }
  const isMainSender = vi.fn(() => options.main !== false)
  const getOwnerWindow = vi.fn(() => (options.owner === undefined ? OWNER : options.owner))
  const registration = registerChannelAgentHandlers(ipc, {
    controller: controller as unknown as ChannelAgentManagementController,
    isMainSender,
    getOwnerWindow
  })
  const invoke = async <T>(channel: string, value?: unknown): Promise<ChannelAgentIpcResult<T>> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler ${channel}`)
    return (await handler(EVENT, value)) as ChannelAgentIpcResult<T>
  }
  return {
    handlers,
    removeHandler,
    controller,
    isMainSender,
    getOwnerWindow,
    registration,
    invoke
  }
}

describe('channelAgentHandlers', () => {
  it('registers and disposes the complete closed agent-management catalogue', () => {
    const target = fixture()
    expect([...target.handlers.keys()].sort()).toEqual(
      Object.values(CHANNEL_AGENT_IPC_CHANNELS).sort()
    )

    target.registration.dispose()

    expect(target.handlers.size).toBe(0)
    for (const channel of Object.values(CHANNEL_AGENT_IPC_CHANNELS)) {
      expect(target.removeHandler).toHaveBeenCalledWith(channel)
    }
  })

  it('requires main-renderer authority before parsing or resolving controller state', async () => {
    const target = fixture({ main: false })

    const result = await target.invoke(CHANNEL_AGENT_IPC_CHANNELS.grant, {
      surprise: 'payload must not become an oracle'
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'not_authorized',
        message: 'Only the main renderer may manage Channel agents.'
      }
    })
    expect(target.controller.grant).not.toHaveBeenCalled()
    expect(target.getOwnerWindow).not.toHaveBeenCalled()
  })

  it('projects an eligible and orphaned-seat overview without controller-only authority', async () => {
    const target = fixture()

    const result = await target.invoke(CHANNEL_AGENT_IPC_CHANNELS.overview, {
      channelId: 'channel-1'
    })

    expect(result).toMatchObject({
      ok: true,
      value: {
        channelId: 'channel-1',
        seats: [
          {
            seat: {
              agentSeatId: BASE_INPUT.agentSeatId,
              provider: 'codex',
              model: 'gpt-5.6-terra'
            },
            membership: { memberId: 'agent-member-2', keyGeneration: 2 }
          }
        ],
        allowedMentioners: [{ memberId: 'owner-member' }]
      }
    })
    expect(target.controller.describeChannel).toHaveBeenCalledWith('channel-1')
    expect(JSON.stringify(result)).not.toMatch(
      /instructions|publicKey|workspaceIdentityHash|signature/i
    )
  })

  it('parses bounded grant authority and projects only the safe outcome', async () => {
    const target = fixture()

    const result = await target.invoke(CHANNEL_AGENT_IPC_CHANNELS.grant, {
      ...BASE_INPUT,
      permissionPresetId: 'read_only',
      allowedMentionerMemberIds: ['reviewer-member', 'owner-member'],
      ttlMs: 300_000,
      maxDispatches: 2
    })

    expect(target.controller.grant).toHaveBeenCalledWith(OWNER, {
      ...BASE_INPUT,
      permissionPresetId: 'read_only',
      allowedMentionerMemberIds: ['owner-member', 'reviewer-member'],
      ttlMs: 300_000,
      maxDispatches: 2
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'applied',
        value: {
          kind: 'grant',
          permissionPresetId: 'read_only',
          maxDispatches: 2
        }
      }
    })
    expect(JSON.stringify(result)).not.toMatch(/permissionPostureHash|identityPublicKey|signature/i)
  })

  it('routes enroll, revoke, and sorted rotation through the requesting native owner', async () => {
    const target = fixture()

    await target.invoke(CHANNEL_AGENT_IPC_CHANNELS.enroll, BASE_INPUT)
    await target.invoke(CHANNEL_AGENT_IPC_CHANNELS.revoke, BASE_INPUT)
    await target.invoke(CHANNEL_AGENT_IPC_CHANNELS.rotate, {
      ...BASE_INPUT,
      reEnrollChannelIds: ['channel-z', 'channel-a']
    })

    expect(target.controller.enroll).toHaveBeenCalledWith(OWNER, BASE_INPUT)
    expect(target.controller.revoke).toHaveBeenCalledWith(OWNER, BASE_INPUT)
    expect(target.controller.rotate).toHaveBeenCalledWith(OWNER, {
      ...BASE_INPUT,
      reEnrollChannelIds: ['channel-a', 'channel-z']
    })
    expect(target.getOwnerWindow).toHaveBeenCalledTimes(3)
  })

  it('preserves declined and stale decisions and passes a missing owner through to fail closed', async () => {
    const target = fixture({ owner: null })
    target.controller.enroll.mockResolvedValueOnce({ status: 'declined' })
    target.controller.revoke.mockResolvedValueOnce({ status: 'stale' })

    await expect(target.invoke(CHANNEL_AGENT_IPC_CHANNELS.enroll, BASE_INPUT)).resolves.toEqual({
      ok: true,
      value: { status: 'declined' }
    })
    await expect(target.invoke(CHANNEL_AGENT_IPC_CHANNELS.revoke, BASE_INPUT)).resolves.toEqual({
      ok: true,
      value: { status: 'stale' }
    })
    expect(target.controller.enroll).toHaveBeenCalledWith(null, BASE_INPUT)
    expect(target.controller.revoke).toHaveBeenCalledWith(null, BASE_INPUT)
  })

  it('rejects unknown, duplicate, malformed, and out-of-bounds authority before mutation', async () => {
    const target = fixture()
    const invalid: Array<[string, unknown]> = [
      [CHANNEL_AGENT_IPC_CHANNELS.overview, { channelId: 'channel-1', extra: true }],
      [CHANNEL_AGENT_IPC_CHANNELS.enroll, { ...BASE_INPUT, requestId: 'bad\nrequest' }],
      [
        CHANNEL_AGENT_IPC_CHANNELS.grant,
        { ...BASE_INPUT, permissionPresetId: 'custom', maxDispatches: 1 }
      ],
      [
        CHANNEL_AGENT_IPC_CHANNELS.grant,
        {
          ...BASE_INPUT,
          permissionPresetId: 'read_only',
          allowedMentionerMemberIds: ['owner-member', 'owner-member']
        }
      ],
      [
        CHANNEL_AGENT_IPC_CHANNELS.grant,
        { ...BASE_INPUT, permissionPresetId: 'read_only', ttlMs: 299_999 }
      ],
      [
        CHANNEL_AGENT_IPC_CHANNELS.grant,
        { ...BASE_INPUT, permissionPresetId: 'read_only', maxDispatches: 101 }
      ],
      [
        CHANNEL_AGENT_IPC_CHANNELS.rotate,
        { ...BASE_INPUT, reEnrollChannelIds: ['channel-a', 'channel-a'] }
      ],
      [CHANNEL_AGENT_IPC_CHANNELS.revoke, { ...BASE_INPUT, signedRevocation: 'forged' }]
    ]

    for (const [channel, value] of invalid) {
      await expect(target.invoke(channel, value)).resolves.toMatchObject({
        ok: false,
        error: { code: 'protocol_unsupported' }
      })
    }
    expect(target.controller.describeChannel).not.toHaveBeenCalled()
    expect(target.controller.enroll).not.toHaveBeenCalled()
    expect(target.controller.grant).not.toHaveBeenCalled()
    expect(target.controller.revoke).not.toHaveBeenCalled()
    expect(target.controller.rotate).not.toHaveBeenCalled()
    expect(target.getOwnerWindow).not.toHaveBeenCalled()
  })

  it('maps known domain failures, redacts their messages, and collapses unknown errors', async () => {
    const target = fixture()
    target.controller.enroll.mockRejectedValueOnce(
      new ChannelError(
        'recovery_blocked',
        'token=super-secret-value /Users/alice/private agent authority failed'
      )
    )
    target.controller.revoke.mockRejectedValueOnce(
      new ChannelAgentManagementError('rotation_required', 'Rotate the stable key first')
    )
    target.controller.rotate.mockRejectedValueOnce(new Error('/Users/alice/private raw failure'))

    const recovery = await target.invoke(CHANNEL_AGENT_IPC_CHANNELS.enroll, BASE_INPUT)
    const rotation = await target.invoke(CHANNEL_AGENT_IPC_CHANNELS.revoke, BASE_INPUT)
    const internal = await target.invoke(CHANNEL_AGENT_IPC_CHANNELS.rotate, BASE_INPUT)

    expect(recovery).toMatchObject({ ok: false, error: { code: 'recovery_blocked' } })
    expect(JSON.stringify(recovery)).not.toMatch(/super-secret-value|Users\/alice/)
    expect(rotation).toEqual({
      ok: false,
      error: { code: 'rotation_required', message: 'Rotate the stable key first' }
    })
    expect(internal).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Channel agent operation failed.' }
    })
  })
})
