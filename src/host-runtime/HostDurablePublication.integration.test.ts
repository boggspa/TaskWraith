import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCommand
} from '../shared/hostProtocol'
import {
  AppStoreHostAuthority,
  type AppStoreHostAuthoritySnapshotDonorFamilies
} from './AppStoreHostAuthority'
import type { HostAuthorityCallContext } from './HostAuthority'
import {
  HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME,
  HOST_COMMAND_RECEIPT_JOURNAL_FILENAME
} from './HostCommandReceiptStore'
import { HOST_DELTA_JOURNAL_FILENAME } from './HostDeltaStore'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import { HostMutationCompletionCoordinator } from './HostMutationCompletionCoordinator'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'

// Real files and real journal writes: only the selected fsync boundary fails.
// This exercises the live Authority -> publisher -> stores -> retry route.
const io = vi.hoisted(() => ({
  paths: new Map<number, string>(),
  fail: undefined as ((path: string) => boolean) | undefined
}))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) {
      const fd = fs.openSync(...args)
      io.paths.set(fd, String(args[0]))
      return fd
    },
    closeSync(fd: number) {
      try {
        return fs.closeSync(fd)
      } finally {
        io.paths.delete(fd)
      }
    },
    fsyncSync(fd: number) {
      if (io.fail?.(io.paths.get(fd) ?? '')) throw new Error('injected journal fsync failure')
      return fs.fsyncSync(fd)
    }
  }
})

const NOW = '2026-09-24T10:00:00.000Z'
const actor: HostActorIdentity = {
  actorId: 'publication-test-actor',
  clientId: 'publication-test-client',
  clientClass: 'desktop'
}
const context: HostAuthorityCallContext = {
  actor,
  client: { clientId: actor.clientId, clientClass: actor.clientClass, clientVersion: 'test' }
}
const command: HostCommand = {
  type: 'host.command',
  protocolVersion: HOST_PROTOCOL_VERSION,
  commandId: 'publication-command',
  idempotencyKey: 'publication-command-key',
  name: 'thread.record.persist',
  actor,
  target: { threadId: 'publication-thread' },
  arguments: {
    transferId: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    byteLength: 1,
    expectedRevision: 0
  },
  issuedAt: NOW
}

function donor(persisted: boolean): AppStoreHostAuthoritySnapshotDonorFamilies {
  return {
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    workspaces: [],
    threads: [
      {
        id: 'publication-thread',
        workspaceId: null,
        title: persisted ? 'After' : 'Before',
        chatKind: 'single',
        archived: false,
        pinned: false,
        updatedAt: persisted ? 2 : 1,
        messageCount: 0
      }
    ],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: []
  }
}

function authorityFixture(runtime: HostRuntimeBootstrap, onExecute: () => void = () => {}) {
  let persisted = false
  const execute = vi.fn(() => {
    persisted = true
    onExecute()
    return { status: 'succeeded' as const, resultSummary: 'thread_record_persisted' }
  })
  return {
    execute,
    authority: new AppStoreHostAuthority({
      mode: 'in-process-migration',
      activationPermit: { hostOwnedStateMayHaveAdvanced: false },
      now: () => NOW,
      ports: {
        runtime,
        snapshotDonor: () => donor(persisted),
        authorityEvaluator: () => ({ decision: 'allowed' }),
        commandExecutor: execute,
        healthProvider: () => donor(persisted).health,
        onShutdown: () => {}
      }
    })
  }
}

describe('Host durable publication integration', () => {
  let hostDataDir: string

  beforeEach(() => {
    hostDataDir = mkdtempSync(join(tmpdir(), 'host-durable-publication-'))
  })

  afterEach(() => {
    io.fail = undefined
    io.paths.clear()
    rmSync(hostDataDir, { recursive: true, force: true })
  })

  it('never turns a failed receipt fsync into successful exact-command replay', async () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })
    const fixture = authorityFixture(runtime, () => {
      io.fail = (path) => path.endsWith(HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    })

    expect(await fixture.authority.command(context, command)).toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    expect(fixture.execute).toHaveBeenCalledOnce()
    expect(runtime.getPosition()).toEqual({ generation: 1, cursor: 1 })
    const found = runtime.receiptStore.getByCommandId(command.commandId, actor)
    expect(found).toMatchObject({ kind: 'found', receipt: { status: 'pending' } })

    // A blocked journal may reject the retry, but it may not invent terminal
    // success or invoke the domain executor again.
    const retry = await fixture.authority.command(context, command)
    if (retry.ok) expect(retry.value.status).toBe('pending')
    else expect(retry.error).toBe('host_unavailable')
    expect(fixture.execute).toHaveBeenCalledOnce()

    const otherCommand = {
      ...command,
      commandId: 'publication-command-2',
      idempotencyKey: 'publication-command-key-2'
    }
    expect(await fixture.authority.command(context, otherCommand)).toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    expect(fixture.execute).toHaveBeenCalledOnce()

    io.fail = undefined
    const recovered = new HostRuntimeBootstrap({ hostDataDir })
    const recoveredFixture = authorityFixture(recovered)
    const replay = await recoveredFixture.authority.command(context, command)
    expect(replay.ok).toBe(true)
    if (replay.ok) {
      // Rollback truncated the terminal line before its own fsync failed.
      // This process reopen sees only the pending anchor and promotes it.
      expect(replay.value.status).toBe('indeterminate')
    }
    expect(recoveredFixture.execute).not.toHaveBeenCalled()
  })

  it('keeps the receipt at the last durable delta position after publication fsync fails', async () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })
    const before = runtime.getPosition()
    const fixture = authorityFixture(runtime, () => {
      io.fail = (path) => path.endsWith(HOST_DELTA_JOURNAL_FILENAME)
    })

    const result = await fixture.authority.command(context, command)
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'indeterminate', generation: before.generation, cursor: before.cursor }
    })
    expect(runtime.getPosition()).toEqual(before)
    expect(fixture.execute).toHaveBeenCalledOnce()
    expect(await fixture.authority.command(context, command)).toMatchObject({
      ok: true,
      value: { status: 'indeterminate', cursor: before.cursor }
    })
    expect(fixture.execute).toHaveBeenCalledOnce()

    io.fail = undefined
    const reopened = new HostRuntimeBootstrap({ hostDataDir })
    expect(reopened.getPosition()).toEqual(before)
    expect(reopened.deltaStore.getByCursor(before.cursor + 1)).toBeNull()
    const recoveredFixture = authorityFixture(reopened)
    expect(await recoveredFixture.authority.command(context, command)).toMatchObject({
      ok: true,
      value: { status: 'indeterminate', cursor: before.cursor }
    })
    expect(recoveredFixture.execute).not.toHaveBeenCalled()
  })

  it('retains fsynced success through receipt checkpoint failure and reopen without re-execution', async () => {
    const runtime = new HostRuntimeBootstrap({
      hostDataDir,
      receipts: { compactAfterRecords: 2 }
    })
    const fixture = authorityFixture(runtime, () => {
      io.fail = (path) => path.includes(HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME)
    })

    expect(await fixture.authority.command(context, command)).toMatchObject({
      ok: true,
      value: { status: 'succeeded', generation: 1, cursor: 1 }
    })
    expect(fixture.execute).toHaveBeenCalledOnce()
    const durable = runtime.receiptStore.getByCommandId(command.commandId, actor)
    expect(durable).toMatchObject({
      kind: 'found',
      receipt: { status: 'succeeded', generation: 1, cursor: 1 }
    })

    io.fail = undefined
    const reopened = new HostRuntimeBootstrap({ hostDataDir })
    const recoveredFixture = authorityFixture(reopened)
    expect(await recoveredFixture.authority.command(context, command)).toMatchObject({
      ok: true,
      value: { status: 'succeeded', generation: 1, cursor: 1 }
    })
    expect(recoveredFixture.execute).not.toHaveBeenCalled()
  })

  it.each(['thread.record.persist', 'run.cancel'] as const)(
    'reports an admission write failure without executing %s',
    async (name) => {
      const runtime = new HostRuntimeBootstrap({ hostDataDir })
      const fixture = authorityFixture(runtime)
      io.fail = (path) => path.endsWith(HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)

      const attempt = {
        ...command,
        name,
        arguments: name === 'run.cancel' ? {} : command.arguments
      }
      expect(await fixture.authority.command(context, attempt)).toEqual({
        ok: false,
        error: 'host_unavailable'
      })
      expect(fixture.execute).not.toHaveBeenCalled()
      expect(runtime.receiptStore.getByCommandId(command.commandId, actor)).toEqual({
        kind: 'not_found'
      })
      expect(runtime.getPosition()).toEqual({ generation: 1, cursor: 0 })

      io.fail = undefined
      const reopened = new HostRuntimeBootstrap({ hostDataDir })
      expect(reopened.receiptStore.getByCommandId(command.commandId, actor)).toEqual({
        kind: 'not_found'
      })
      const recoveredFixture = authorityFixture(reopened)
      expect(await recoveredFixture.authority.command(context, attempt)).toMatchObject({
        ok: true,
        value: { status: 'succeeded' }
      })
      expect(await recoveredFixture.authority.command(context, attempt)).toMatchObject({
        ok: true,
        value: { status: 'succeeded' }
      })
      expect(recoveredFixture.execute).toHaveBeenCalledOnce()
    }
  )

  it('does not report missing receipts when checkpoint recovery cannot establish absence', async () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })
    const fixture = authorityFixture(runtime)
    expect(await fixture.authority.command(context, command)).toMatchObject({
      ok: true,
      value: { status: 'succeeded' }
    })
    runtime.receiptStore.compact()
    writeFileSync(join(hostDataDir, HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME), '{broken checkpoint')
    runtime.receiptStore.reopen()

    // Failed recovery preserves the instance's last durable reads.
    expect(
      await fixture.authority.receipt(context, { commandId: command.commandId })
    ).toMatchObject({
      ok: true,
      outcome: 'found',
      receipt: { status: 'succeeded' }
    })
    expect(await fixture.authority.receipt(context, { commandId: 'unknown-command' })).toEqual({
      ok: false,
      error: 'host_unavailable'
    })

    const reopened = new HostRuntimeBootstrap({ hostDataDir })
    const recoveredFixture = authorityFixture(reopened)
    for (const lookup of [
      { commandId: command.commandId },
      { idempotencyKey: command.idempotencyKey }
    ]) {
      expect(await recoveredFixture.authority.receipt(context, lookup)).toEqual({
        ok: false,
        error: 'host_unavailable'
      })
    }
    expect(await recoveredFixture.authority.command(context, command)).toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    expect(recoveredFixture.execute).not.toHaveBeenCalled()
  })

  it('does not consume a deferred envelope after a failed terminal receipt fsync', async () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })
    runtime.receiptStore.begin({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandName: command.name,
      commandFingerprint: 'a'.repeat(64),
      actor,
      target: { kind: 'thread', id: 'publication-thread' },
      authority: { decision: 'allowed' }
    })
    const publisher = new HostDomainDeltaPublisher({ store: runtime.deltaStore })
    const consume = vi.fn(() => ({ kind: 'updated' as const }))
    const coordinator = new HostMutationCompletionCoordinator({
      publishEffects: (effects) => publisher.publish(effects),
      getPosition: () => runtime.getPosition(),
      completeReceipt: (input) => runtime.receiptStore.complete(input),
      markIndeterminate: (input) => runtime.receiptStore.markIndeterminate(input),
      markEnvelopeConsumed: consume
    })
    io.fail = (path) => path.endsWith(HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const input = {
      commandId: command.commandId,
      mutation: {
        kind: 'observed' as const,
        execution: { status: 'succeeded' as const },
        effects: []
      }
    }

    expect(coordinator.complete(input)).toEqual({ kind: 'anomaly', reason: 'complete_threw' })
    expect(coordinator.complete(input)).toEqual({ kind: 'anomaly', reason: 'complete_threw' })
    expect(consume).not.toHaveBeenCalled()
    expect(runtime.receiptStore.getByCommandId(command.commandId, actor)).toMatchObject({
      kind: 'found',
      receipt: { status: 'pending' }
    })
  })
})
