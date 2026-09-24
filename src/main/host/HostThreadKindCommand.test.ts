import { describe, expect, it, vi } from 'vitest'

import type { HostCommand, HostCommandReceipt } from '../../shared/hostProtocol'
import { TASKWRAITH_DESKTOP_HOST_ACTOR } from '../../shared/hostProtocol'
import type { ChatRecord } from '../store/types'
import {
  createHostThreadKindMutation,
  HostThreadKindCommandClient,
  type HostThreadKindCommandBrokerPort
} from './HostThreadKindCommand'

function receipt(command: HostCommand, status: HostCommandReceipt['status']): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: 2,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    name: command.name,
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    authority: { decision: 'allow' },
    status,
    commandFingerprint: 'a'.repeat(64),
    generation: 1,
    cursor: 1,
    createdAt: command.issuedAt,
    updatedAt: command.issuedAt,
    ...(status === 'succeeded'
      ? { resultRef: { kind: 'thread' as const, threadId: command.target.threadId } }
      : {})
  }
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'global',
    provider: 'codex',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('HostThreadKindCommandClient', () => {
  it('submits the selected solo provider through the authoritative Host command', async () => {
    let submitted: HostCommand | null = null
    const broker: HostThreadKindCommandBrokerPort = {
      submitCommand: vi.fn(async (command) => {
        submitted = command
        return { ok: true as const, receipt: receipt(command, 'succeeded') }
      }),
      lookupReceipt: vi.fn()
    }
    const client = new HostThreadKindCommandClient({
      broker,
      createId: () => '8c2f3ec4-54c0-4f41-bf7a-8d981e1f75fd',
      nowMs: () => 1_000
    })

    await expect(
      client.setKind({ chatId: 'chat-1', targetKind: 'single', canonicalProvider: 'kimi' })
    ).resolves.toMatchObject({ ok: true })
    expect(submitted).toMatchObject({
      name: 'thread.configure',
      target: { threadId: 'chat-1' },
      arguments: { chatKind: 'single', canonicalProviderId: 'kimi' },
      actor: TASKWRAITH_DESKTOP_HOST_ACTOR
    })
  })

  it('uses the Boss as the backend fallback and returns the refreshed canonical chat', async () => {
    const setKind = vi.fn(async () => ({ ok: true as const, receipt: {} as HostCommandReceipt }))
    const before = chat({
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 18,
        orchestrationMode: 'turn_bound',
        maxContinuationHops: 6,
        participants: [
          {
            id: 'codex-first',
            provider: 'codex',
            enabled: true,
            role: 'First',
            instructions: '',
            order: 1
          },
          {
            id: 'kimi-boss',
            provider: 'kimi',
            enabled: true,
            role: 'Boss',
            instructions: '',
            order: 2
          }
        ],
        bossmanParticipantId: 'kimi-boss',
        updatedAt: '2026-08-27T00:00:00.000Z'
      }
    })
    const after = chat({ chatKind: 'single', provider: 'kimi' })
    const getChat = vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after)
    const mutate = createHostThreadKindMutation({ client: { setKind }, getChat })

    await expect(mutate({ chatId: 'chat-1', targetKind: 'single' })).resolves.toBe(after)
    expect(setKind).toHaveBeenCalledWith({
      chatId: 'chat-1',
      targetKind: 'single',
      canonicalProvider: 'kimi'
    })
  })

  it('surfaces a Host refusal instead of claiming the popup selection worked', async () => {
    const mutate = createHostThreadKindMutation({
      client: {
        setKind: vi.fn(async () => ({
          ok: false as const,
          code: 'setup_execution_failed',
          message: 'Host refused the mode change.'
        }))
      },
      getChat: vi.fn(() => chat({ chatKind: 'ensemble' }))
    })

    await expect(
      mutate({ chatId: 'chat-1', targetKind: 'single', canonicalProvider: 'codex' })
    ).rejects.toThrow('Host refused the mode change.')
  })
})
