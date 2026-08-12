import { describe, expect, it, vi } from 'vitest'

import type { HostCommand, HostCommandReceipt } from '../../shared/hostProtocol'
import { TASKWRAITH_DESKTOP_HOST_ACTOR } from '../../shared/hostProtocol'
import {
  HostChannelAdminCommandClient,
  type HostChannelAdminCommandBrokerPort
} from './HostChannelAdminCommandClient'

function receipt(command: HostCommand, status: HostCommandReceipt['status']): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: 2,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    name: command.name,
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    authority: status === 'pending' ? { decision: 'ask' } : { decision: 'allow' },
    status,
    commandFingerprint: 'a'.repeat(64),
    generation: 1,
    cursor: 1,
    createdAt: command.issuedAt,
    updatedAt: command.issuedAt
  }
}

describe('HostChannelAdminCommandClient', () => {
  it('submits an exact Desktop command and polls its durable receipt to success', async () => {
    let submitted: HostCommand | null = null
    let now = 1_000
    const broker: HostChannelAdminCommandBrokerPort = {
      submitCommand: vi.fn(async (command) => {
        submitted = command
        return { ok: true as const, receipt: receipt(command, 'pending') }
      }),
      lookupReceipt: vi.fn(async () => ({
        ok: true as const,
        receipt: receipt(submitted!, 'succeeded')
      }))
    }
    const client = new HostChannelAdminCommandClient({
      broker,
      createId: () => '8c2f3ec4-54c0-4f41-bf7a-8d981e1f75fd',
      nowMs: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      },
      pollIntervalMs: 25,
      timeoutMs: 100
    })

    const result = await client.revokeMember({ channelId: 'channel-a', memberId: 'member-a' })

    expect(result.ok).toBe(true)
    expect(submitted).toMatchObject({
      name: 'channel.member.revoke',
      target: { channelId: 'channel-a' },
      arguments: { memberId: 'member-a' },
      actor: TASKWRAITH_DESKTOP_HOST_ACTOR
    })
    expect(broker.lookupReceipt).toHaveBeenCalledWith('8c2f3ec4-54c0-4f41-bf7a-8d981e1f75fd')
  })

  it('fails closed on a mismatched or denied receipt', async () => {
    const mismatchBroker: HostChannelAdminCommandBrokerPort = {
      submitCommand: vi.fn(async (command) => ({
        ok: true as const,
        receipt: { ...receipt(command, 'succeeded'), commandId: 'different-command' }
      })),
      lookupReceipt: vi.fn()
    }
    await expect(
      new HostChannelAdminCommandClient({ broker: mismatchBroker }).closeChannel('channel-a')
    ).resolves.toEqual({
      ok: false,
      code: 'invalid_host_receipt',
      message: 'Host receipt did not match command'
    })

    const deniedBroker: HostChannelAdminCommandBrokerPort = {
      submitCommand: vi.fn(async (command) => ({
        ok: true as const,
        receipt: {
          ...receipt(command, 'denied'),
          authority: { decision: 'deny' as const, reason: 'user denied' },
          errorCode: 'human_only',
          errorMessage: 'Agent removal requires signed owner revocation'
        }
      })),
      lookupReceipt: vi.fn()
    }
    await expect(
      new HostChannelAdminCommandClient({ broker: deniedBroker }).revokeMember({
        channelId: 'channel-a',
        memberId: 'agent-a'
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'human_only',
      message: 'Agent removal requires signed owner revocation'
    })
  })

  it('recovers an ambiguously submitted command by its durable commandId', async () => {
    let submitted: HostCommand | null = null
    const broker: HostChannelAdminCommandBrokerPort = {
      submitCommand: vi.fn(async (command) => {
        submitted = command
        return { ok: false as const, error: 'socket closed after write' }
      }),
      lookupReceipt: vi.fn(async (commandId) => {
        expect(commandId).toBe(submitted?.commandId)
        return { ok: true as const, receipt: receipt(submitted!, 'succeeded') }
      })
    }

    const result = await new HostChannelAdminCommandClient({ broker }).closeChannel('channel-a')

    expect(result.ok).toBe(true)
    expect(broker.submitCommand).toHaveBeenCalledTimes(1)
    expect(broker.lookupReceipt).toHaveBeenCalledTimes(1)
  })
})
