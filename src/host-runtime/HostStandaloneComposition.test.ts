import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import { createHostStandaloneComposition } from './HostStandaloneComposition'

const paths: string[] = []
const actor = { actorId: 'actor-1', clientId: 'client-1', clientClass: 'test' as const }
const context = {
  actor,
  client: { clientId: 'client-1', clientClass: 'test' as const, clientVersion: '1.0.0' }
}

afterEach(() => {
  while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true })
})

function command(): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'standalone-command-1',
    idempotencyKey: 'standalone-key-1',
    actor,
    name: 'thread.select',
    target: { threadId: 'thread-1' },
    arguments: {},
    issuedAt: '2026-08-24T00:00:00.000Z'
  }
}

function input(runtimePath: string, lease: { assertHeld(): void }) {
  return {
    runtimePath,
    lease,
    host: { hostId: 'standalone-host', hostVersion: '1.0.0' },
    hostCapabilityOffer: [
      'bootstrap',
      'snapshot',
      'deltas',
      'commands',
      'receipts',
      'health'
    ] as const,
    snapshotDonor: () => ({
      health: {
        hostStatus: 'ok' as const,
        connectionPhase: 'live' as const,
        supervised: false,
        freshness: 'live' as const
      },
      workspaces: [],
      threads: [],
      runs: [],
      missions: [],
      rounds: [],
      participants: [],
      providers: [],
      questions: [],
      approvals: [],
      schedules: [],
      usage: { availability: 'unavailable' as const },
      artifacts: [],
      warnings: []
    }),
    authorityEvaluator: () => ({ decision: 'allowed' as const }),
    commandExecutor: () => ({ status: 'succeeded' as const }),
    healthProvider: () => ({
      hostStatus: 'ok' as const,
      connectionPhase: 'live' as const,
      supervised: false,
      freshness: 'live' as const
    })
  }
}

describe('HostStandaloneComposition', () => {
  it('asserts the lease before opening the sole runtime and recovers receipt state after restart', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-'))
    paths.push(runtimePath)
    const order: string[] = []
    const lease = { assertHeld: vi.fn(() => order.push('lease')) }
    const first = createHostStandaloneComposition(input(runtimePath, lease))
    expect(order).toEqual(['lease'])
    const result = await first.authority.command(context, command())
    expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
    await first.shutdown()

    const secondLease = { assertHeld: vi.fn() }
    const second = createHostStandaloneComposition(input(runtimePath, secondLease))
    const replay = await second.authority.command(context, command())
    expect(replay).toMatchObject({
      ok: true,
      value: { commandId: 'standalone-command-1', status: 'succeeded' }
    })
    await second.shutdown()
  })

  it('forwards the optional workspace Git read provider into Authority', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-git-'))
    paths.push(runtimePath)
    const gitReadProvider = vi.fn(() => ({
      scope: 'status' as const,
      branch: 'main',
      head: 'a'.repeat(40),
      files: [],
      truncated: false
    }))
    const composition = createHostStandaloneComposition({
      ...input(runtimePath, { assertHeld: vi.fn() }),
      gitReadProvider
    })

    await expect(
      composition.authority.gitRead?.(context, {
        workspaceId: 'workspace-1',
        scope: 'status'
      })
    ).resolves.toMatchObject({ ok: true, value: { scope: 'status' } })
    expect(gitReadProvider).toHaveBeenCalledWith(context, {
      workspaceId: 'workspace-1',
      scope: 'status'
    })
    await composition.shutdown()
  })

  it('does not construct a standalone composition when the lease assertion fails', () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-fail-'))
    paths.push(runtimePath)
    expect(() =>
      createHostStandaloneComposition(
        input(runtimePath, {
          assertHeld: () => {
            throw new Error('lease missing')
          }
        })
      )
    ).toThrow('lease missing')
  })
})
