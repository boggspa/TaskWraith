import { describe, expect, it } from 'vitest'
import { HOST_PROTOCOL_VERSION, type HostCommandReceipt } from '../../../../shared/hostProtocol'
import {
  buildHostCommand,
  describeHostReceipt,
  isTerminalHostReceiptStatus,
  pollHostReceiptUntilTerminal
} from './hostCommandFlow'

function receipt(overrides: Partial<HostCommandReceipt> = {}): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'cmd-1',
    idempotencyKey: 'key-1',
    name: 'composer.send',
    actor: { actorId: 'desktop-1', clientId: 'desktop-1', clientClass: 'desktop' },
    authority: { decision: 'ask' },
    status: 'pending',
    commandFingerprint: 'a'.repeat(64),
    generation: 1,
    cursor: 1,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides
  }
}

describe('hostCommandFlow · Desktop Wave 4.3b', () => {
  it('builds a decode-shaped Host command with minted ids', () => {
    const command = buildHostCommand({
      name: 'composer.send',
      actor: { actorId: 'desktop-1', clientId: 'desktop-1', clientClass: 'desktop' },
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    expect(command.type).toBe('host.command')
    expect(command.protocolVersion).toBe(HOST_PROTOCOL_VERSION)
    expect(command.commandId.length).toBeGreaterThan(8)
    expect(command.idempotencyKey.length).toBeGreaterThan(8)
    expect(command.arguments.text).toBe('hello')
  })

  it('never describes pending as success', () => {
    const pending = describeHostReceipt(receipt())
    expect(pending.tone).toBe('warning')
    expect(pending.text).toMatch(/Awaiting Host approval/i)
    expect(pending.text).not.toMatch(/accepted|succeeded/i)

    const ok = describeHostReceipt(
      receipt({ status: 'succeeded', authority: { decision: 'allow' } })
    )
    expect(ok.tone).toBe('good')
    expect(ok.text).toMatch(/accepted/i)
  })

  it('polls until a terminal receipt and leaves pending untouched on timeout', async () => {
    const sleeps: number[] = []
    let calls = 0
    const terminal = await pollHostReceiptUntilTerminal({
      commandId: 'cmd-1',
      timeoutMs: 1_000,
      initialDelayMs: 10,
      maxDelayMs: 20,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      lookup: async () => {
        calls += 1
        if (calls < 3) return receipt({ status: 'pending' })
        return receipt({ status: 'succeeded', authority: { decision: 'allow' } })
      }
    })
    expect(terminal.status).toBe('succeeded')
    expect(calls).toBe(3)
    expect(sleeps.length).toBeGreaterThan(0)
    expect(isTerminalHostReceiptStatus('pending')).toBe(false)
    expect(isTerminalHostReceiptStatus('succeeded')).toBe(true)

    const stuck = await pollHostReceiptUntilTerminal({
      commandId: 'cmd-1',
      timeoutMs: 30,
      initialDelayMs: 5,
      maxDelayMs: 5,
      sleep: async () => undefined,
      lookup: async () => receipt({ status: 'pending' })
    })
    expect(stuck.status).toBe('pending')
    expect(isTerminalHostReceiptStatus(stuck.status)).toBe(false)
  })

  it('aborts polling when shouldAbort flips', async () => {
    let calls = 0
    const result = await pollHostReceiptUntilTerminal({
      commandId: 'cmd-1',
      timeoutMs: 5_000,
      initialDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => undefined,
      shouldAbort: () => calls >= 1,
      lookup: async () => {
        calls += 1
        return receipt({ status: 'pending' })
      }
    })
    expect(result.status).toBe('pending')
    expect(calls).toBe(1)
  })
})
