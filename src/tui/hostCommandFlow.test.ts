import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostDeferredCommandEnvelopeStore } from '../host-runtime/HostDeferredCommandEnvelopeStore'
import { fingerprintHostCommand } from '../host-runtime/HostCommandFingerprint'
import { HOST_PROTOCOL_VERSION, type HostCommandReceipt } from '../shared/hostProtocol'
import {
  buildHostCommand,
  buildProviderAuthCancelCommand,
  buildProviderAuthBeginCommand,
  buildThreadArchiveCommand,
  buildThreadConfigureCommand,
  buildThreadCreateCommand,
  buildWorkspaceRegisterCommand,
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
    actor: { actorId: 'tui-1', clientId: 'tui-1', clientClass: 'tui' },
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

describe('hostCommandFlow', () => {
  it('builds a decode-shaped Host command with minted ids', () => {
    const command = buildHostCommand({
      name: 'composer.send',
      actor: { actorId: 'tui-1', clientId: 'tui-1', clientClass: 'tui' },
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    expect(command.type).toBe('host.command')
    expect(command.protocolVersion).toBe(HOST_PROTOCOL_VERSION)
    expect(command.commandId.length).toBeGreaterThan(8)
    expect(command.idempotencyKey.length).toBeGreaterThan(8)
    expect(command.arguments.text).toBe('hello')
  })

  it('builds exact bounded Host setup commands without inventing auth operation ids', () => {
    const actor = { actorId: 'tui-1', clientId: 'tui-1', clientClass: 'tui' } as const
    expect(
      buildWorkspaceRegisterCommand({ actor, path: '/workspace', pinned: true })
    ).toMatchObject({
      name: 'workspace.register',
      target: {},
      arguments: { path: '/workspace', pinned: true }
    })
    expect(
      buildThreadCreateCommand({ actor, scope: 'workspace', workspaceId: 'workspace-1' })
    ).toMatchObject({
      name: 'thread.create',
      arguments: { scope: 'workspace', workspaceId: 'workspace-1' }
    })
    expect(
      buildThreadConfigureCommand({
        actor,
        selection: {
          threadId: 'thread-1',
          providerId: 'codex',
          modelId: 'gpt-5.6',
          postureId: 'plan',
          offerRevision: 'offers-r1',
          reasoningId: 'high',
          postureConsent: true
        }
      })
    ).toMatchObject({
      name: 'thread.configure',
      target: { threadId: 'thread-1' },
      arguments: {
        providerId: 'codex',
        modelId: 'gpt-5.6',
        reasoningId: 'high',
        postureId: 'plan',
        offerRevision: 'offers-r1',
        postureConsent: true
      }
    })
    expect(
      buildThreadArchiveCommand({ actor, threadId: 'thread-1', archived: true })
    ).toMatchObject({
      name: 'thread.archive',
      arguments: { archived: true }
    })
    const auth = buildProviderAuthBeginCommand({ actor, providerId: 'codex', flowId: 'browser' })
    expect(auth).toMatchObject({
      name: 'provider.auth.begin',
      target: { providerId: 'codex' },
      arguments: { flowId: 'browser' }
    })
    expect(auth.arguments).not.toHaveProperty('operationId')
    expect(
      buildProviderAuthCancelCommand({ actor, providerId: 'codex', operationId: 'auth-op-1' })
    ).toMatchObject({
      name: 'provider.auth.cancel',
      target: { providerId: 'codex', operationId: 'auth-op-1' },
      arguments: {}
    })
    expect(
      buildThreadConfigureCommand({
        actor,
        selection: { threadId: 'thread-1', title: 'Renamed thread' }
      })
    ).toMatchObject({
      name: 'thread.configure',
      target: { threadId: 'thread-1' },
      arguments: { title: 'Renamed thread' }
    })
  })

  it('mints the actor-bound idempotency key required by deferred Host storage', () => {
    const command = buildHostCommand({
      name: 'thread.select',
      actor: { actorId: 'tui-1', clientId: 'tui-1', clientClass: 'tui' },
      target: { threadId: 'thread-1' }
    })
    const dataDir = mkdtempSync(join(tmpdir(), 'tw-tui-command-identity-'))

    try {
      const store = new HostDeferredCommandEnvelopeStore({ dataDir })
      expect(
        store.put({
          deferredId: '11111111-1111-4111-8111-111111111111',
          challengeId: '22222222-2222-4222-8222-222222222222',
          challengeKind: 'approval',
          commandFingerprint: fingerprintHostCommand(command).fingerprint,
          command
        })
      ).toEqual({ kind: 'created' })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
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
      initialDelayMs: 10,
      maxDelayMs: 10,
      sleep: async () => {},
      lookup: async () => receipt({ status: 'pending' })
    })
    expect(stuck.status).toBe('pending')
    expect(describeHostReceipt(stuck).text).toMatch(/Awaiting Host approval/i)
  })

  it('aborts polling when shouldAbort flips', async () => {
    let abort = false
    vi.useFakeTimers()
    const pending = pollHostReceiptUntilTerminal({
      commandId: 'cmd-1',
      timeoutMs: 60_000,
      initialDelayMs: 100,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      shouldAbort: () => abort,
      lookup: async () => receipt({ status: 'pending' })
    })
    await vi.advanceTimersByTimeAsync(50)
    abort = true
    await vi.advanceTimersByTimeAsync(200)
    const got = await pending
    expect(got.status).toBe('pending')
    vi.useRealTimers()
  })
})
