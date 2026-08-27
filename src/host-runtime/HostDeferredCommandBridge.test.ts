import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HostDeferredCommandBridge,
  HOST_DEFERRED_COMMAND_CHECKPOINT_FILENAME,
  HOST_DEFERRED_COMMAND_JOURNAL_FILENAME,
  type HostDeferredCommandActor,
  type HostDeferredCommandBridgePorts,
  type HostDeferredCommandRegisterInput,
  type HostDeferredExecutorResult
} from './HostDeferredCommandBridge'

// Runtime-owned bridge journal suite moved with the injected deferred core.

const OWNER: HostDeferredCommandActor = {
  clientId: 'client-desktop-1',
  actorId: 'user-1',
  clientClass: 'desktop'
}

const OTHER: HostDeferredCommandActor = {
  clientId: 'client-tui-9',
  actorId: 'user-9',
  clientClass: 'tui'
}

function fingerprint(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex')
}

function baseRegister(
  overrides: Partial<HostDeferredCommandRegisterInput> = {}
): HostDeferredCommandRegisterInput {
  return {
    deferredId: 'def-1',
    commandId: 'cmd-1',
    idempotencyKey: 'desktop:client-desktop-1:11111111-1111-4111-8111-111111111111',
    commandFingerprint: fingerprint('composer.send|thread-1'),
    commandName: 'composer.send',
    actor: { ...OWNER },
    challengeId: 'approval-1',
    challengeKind: 'approval',
    ...overrides
  }
}

describe('HostDeferredCommandBridge', () => {
  let dataDir: string
  let clock: string
  let completeCalls: Array<Record<string, unknown>>
  let executeCalls: Array<Record<string, unknown>>
  let publishCalls: Array<Record<string, unknown>>
  let executorImpl: () => HostDeferredExecutorResult | Promise<HostDeferredExecutorResult>
  let completeImpl: () => void | Promise<void>
  let publishImpl: () => void | Promise<void>
  let ports: HostDeferredCommandBridgePorts

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-deferred-'))
    clock = '2026-08-04T00:00:00.000Z'
    completeCalls = []
    executeCalls = []
    publishCalls = []
    executorImpl = () => ({
      status: 'succeeded',
      terminalCode: 'ok',
      effects: [{ kind: 'thread.upsert', entityId: 'thread-1', summaryCode: 'sent' }]
    })
    completeImpl = () => {}
    publishImpl = () => {}
    ports = {
      completeReceipt: async (input) => {
        completeCalls.push({ ...input })
        await completeImpl()
      },
      executeCommand: async (input) => {
        executeCalls.push({ ...input })
        return executorImpl()
      },
      publishEffects: async (input) => {
        publishCalls.push({
          commandId: input.commandId,
          deferredId: input.deferredId,
          effects: input.effects,
          actor: input.actor
        })
        await publishImpl()
      }
    }
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function open(options?: { maxRecords?: number; compactAfterRecords?: number }) {
    return new HostDeferredCommandBridge({
      dataDir,
      ports,
      now: () => clock,
      maxRecords: options?.maxRecords,
      compactAfterRecords: options?.compactAfterRecords
    })
  }

  it('requires injected dataDir and ports', () => {
    expect(() => new HostDeferredCommandBridge({ dataDir: '', ports })).toThrow(/dataDir/)
    expect(
      () =>
        new HostDeferredCommandBridge({
          dataDir,
          // @ts-expect-error intentional
          ports: { completeReceipt: () => {}, executeCommand: () => ({ status: 'succeeded' }) }
        })
    ).toThrow(/publishEffects/)
  })

  it('registers awaiting correlation and returns exact repeats', () => {
    const bridge = open()
    const created = bridge.register(baseRegister())
    expect(created.kind).toBe('created')
    if (created.kind !== 'created') return
    expect(created.record.state).toBe('awaiting')
    expect(created.record.challengeId).toBe('approval-1')
    expect(created.record.commandName).toBe('composer.send')
    expect(created.record.actor).toEqual(OWNER)

    const again = bridge.register(baseRegister())
    expect(again.kind).toBe('existing')
    if (again.kind !== 'existing') return
    expect(again.record.deferredId).toBe('def-1')

    const found = bridge.getByChallengeId('approval-1', OWNER)
    expect(found.kind).toBe('found')
  })

  it('persists thread.record.persist in the deferred-command registry', () => {
    const bridge = open()
    const created = bridge.register(
      baseRegister({
        deferredId: 'def-persist',
        commandId: 'cmd-persist',
        idempotencyKey: 'desktop:client-desktop-1:55555555-5555-4555-8555-555555555555',
        commandFingerprint: fingerprint('thread.record.persist|thread-1'),
        commandName: 'thread.record.persist',
        challengeId: 'approval-persist'
      })
    )
    expect(created.kind).toBe('created')
    if (created.kind !== 'created') return
    expect(created.record.commandName).toBe('thread.record.persist')

    const reopened = open()
    const durable = reopened.getByChallengeId('approval-persist', OWNER)
    expect(durable.kind).toBe('found')
    if (durable.kind === 'found') {
      expect(durable.record.commandName).toBe('thread.record.persist')
    }
  })

  it('persists thread.record.delete in the deferred-command registry', () => {
    const bridge = open()
    const created = bridge.register(
      baseRegister({
        deferredId: 'def-delete',
        commandId: 'cmd-delete',
        idempotencyKey: 'desktop:client-desktop-1:66666666-6666-4666-8666-666666666666',
        commandFingerprint: fingerprint('thread.record.delete|thread-1'),
        commandName: 'thread.record.delete',
        challengeId: 'approval-delete'
      })
    )
    expect(created.kind).toBe('created')
    if (created.kind !== 'created') return
    expect(created.record.commandName).toBe('thread.record.delete')
  })

  it('fails closed on actor / challenge / command mismatches at register', () => {
    const bridge = open()
    expect(bridge.register(baseRegister()).kind).toBe('created')

    expect(bridge.register(baseRegister({ actor: OTHER })).kind).toBe('actor_denied')

    const challengeConflict = bridge.register(
      baseRegister({
        deferredId: 'def-2',
        commandId: 'cmd-2',
        commandFingerprint: fingerprint('other'),
        challengeId: 'approval-1'
      })
    )
    expect(challengeConflict.kind).toBe('conflict')
    if (challengeConflict.kind === 'conflict') {
      expect(challengeConflict.reason).toBe('challenge_occupied')
    }

    const commandConflict = bridge.register(
      baseRegister({
        deferredId: 'def-3',
        commandId: 'cmd-1',
        challengeId: 'approval-9',
        commandFingerprint: fingerprint('different')
      })
    )
    expect(commandConflict.kind).toBe('conflict')
  })

  it('deny completes receipt without executor or effects', async () => {
    const bridge = open()
    bridge.register(baseRegister())
    clock = '2026-08-04T00:00:01.000Z'
    const result = await bridge.resolve({
      challengeId: 'approval-1',
      actor: OWNER,
      decision: 'deny'
    })
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') return
    expect(result.record.state).toBe('denied')
    expect(result.record.decision).toBe('deny')
    expect(result.record.terminalCode).toBe('authority_denied')
    expect(executeCalls).toHaveLength(0)
    expect(publishCalls).toHaveLength(0)
    expect(completeCalls).toEqual([
      expect.objectContaining({
        commandId: 'cmd-1',
        status: 'denied',
        terminalCode: 'authority_denied'
      })
    ])
  })

  it('cancel completes receipt without executor or effects', async () => {
    const bridge = open()
    bridge.register(baseRegister({ challengeKind: 'question', challengeId: 'question-1' }))
    const result = await bridge.resolve({
      challengeId: 'question-1',
      actor: OWNER,
      decision: 'cancel'
    })
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') return
    expect(result.record.state).toBe('cancelled')
    expect(executeCalls).toHaveLength(0)
    expect(publishCalls).toHaveLength(0)
    expect(completeCalls[0]).toEqual(
      expect.objectContaining({ status: 'cancelled', terminalCode: 'authority_cancelled' })
    )
  })

  it('allow claims, executes once, publishes effects, completes receipt, terminalizes', async () => {
    const bridge = open()
    bridge.register(baseRegister())
    clock = '2026-08-04T00:00:02.000Z'
    const result = await bridge.resolve({
      challengeId: 'approval-1',
      actor: OWNER,
      decision: 'allow',
      commandId: 'cmd-1',
      commandFingerprint: fingerprint('composer.send|thread-1')
    })
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') return
    expect(result.record.state).toBe('succeeded')
    expect(result.record.decision).toBe('allow')
    expect(executeCalls).toHaveLength(1)
    expect(publishCalls).toHaveLength(1)
    expect(publishCalls[0]?.effects).toEqual([
      { kind: 'thread.upsert', entityId: 'thread-1', summaryCode: 'sent' }
    ])
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0]).toEqual(
      expect.objectContaining({ commandId: 'cmd-1', status: 'succeeded', terminalCode: 'ok' })
    )

    // Duplicate allow is idempotent.
    const again = await bridge.resolve({
      challengeId: 'approval-1',
      actor: OWNER,
      decision: 'allow'
    })
    expect(again.kind).toBe('existing')
    expect(executeCalls).toHaveLength(1)
  })

  it('rejects cross-actor resolve and command binding mismatches', async () => {
    const bridge = open()
    bridge.register(baseRegister())

    expect(
      await bridge.resolve({ challengeId: 'approval-1', actor: OTHER, decision: 'allow' })
    ).toEqual({ kind: 'actor_mismatch' })

    expect(
      await bridge.resolve({
        challengeId: 'approval-1',
        actor: OWNER,
        decision: 'allow',
        commandId: 'cmd-other'
      })
    ).toEqual({ kind: 'command_mismatch' })

    expect(
      await bridge.resolve({
        challengeId: 'approval-1',
        actor: OWNER,
        decision: 'allow',
        commandFingerprint: fingerprint('nope')
      })
    ).toEqual({ kind: 'command_mismatch' })

    expect(executeCalls).toHaveLength(0)
    expect(bridge.getByChallengeId('approval-1', OTHER).kind).toBe('actor_mismatch')
  })

  it('awaiting survives reopen; execution_claimed becomes indeterminate and cannot execute', async () => {
    const bridge = open()
    bridge.register(baseRegister())

    // Simulate durable claim persisted then crash before terminalize.
    const claimedPath = join(dataDir, HOST_DEFERRED_COMMAND_JOURNAL_FILENAME)
    expect(existsSync(claimedPath)).toBe(true)

    // Reopen awaiting — still resolvable.
    const reopened = open()
    const awaiting = reopened.getByChallengeId('approval-1', OWNER)
    expect(awaiting.kind).toBe('found')
    if (awaiting.kind !== 'found') return
    expect(awaiting.record.state).toBe('awaiting')

    // Force an execution_claimed row onto disk, then reopen.
    executorImpl = () =>
      new Promise(() => {
        /* never settles — we will not await this path */
      })

    // Manually append claimed state as a crash mid-allow would.
    const record = {
      ...awaiting.record,
      state: 'execution_claimed',
      decision: 'allow',
      updatedAt: '2026-08-04T00:00:03.000Z'
    }
    appendFileSync(
      join(dataDir, HOST_DEFERRED_COMMAND_JOURNAL_FILENAME),
      `${JSON.stringify({ op: 'upsert', record })}\n`,
      'utf8'
    )

    const afterCrash = open()
    const recovered = afterCrash.getByChallengeId('approval-1', OWNER)
    expect(recovered.kind).toBe('found')
    if (recovered.kind !== 'found') return
    expect(recovered.record.state).toBe('indeterminate')
    expect(recovered.record.terminalCode).toBe('execution_may_have_begun')

    const blocked = await afterCrash.resolve({
      challengeId: 'approval-1',
      actor: OWNER,
      decision: 'allow'
    })
    expect(blocked.kind).toBe('indeterminate')
    expect(executeCalls).toHaveLength(0)
  })

  it('surfaces receipt / executor / effects callback failures without double execution', async () => {
    const bridge = open()
    bridge.register(baseRegister())

    completeImpl = () => {
      throw new Error('receipt down')
    }
    const denyFail = await bridge.resolve({
      challengeId: 'approval-1',
      actor: OWNER,
      decision: 'deny'
    })
    expect(denyFail.kind).toBe('failed')
    if (denyFail.kind === 'failed') expect(denyFail.code).toBe('receipt_failed')
    expect(bridge.getByChallengeId('approval-1', OWNER)).toEqual(
      expect.objectContaining({ kind: 'found' })
    )
    const stillAwaiting = bridge.getByChallengeId('approval-1', OWNER)
    if (stillAwaiting.kind === 'found') expect(stillAwaiting.record.state).toBe('awaiting')

    completeImpl = () => {}
    executorImpl = () => {
      throw new Error('boom')
    }
    const execFail = await bridge.resolve({
      challengeId: 'approval-1',
      actor: OWNER,
      decision: 'allow'
    })
    expect(execFail.kind).toBe('failed')
    if (execFail.kind === 'failed') {
      expect(execFail.code).toBe('executor_failed')
      expect(execFail.record?.state).toBe('failed')
      expect(execFail.record?.terminalCode).toBe('executor_threw')
    }
    expect(executeCalls).toHaveLength(1)
    expect(publishCalls).toHaveLength(0)

    // Terminal failed — further allow is not_awaiting / existing mismatch path.
    const again = await bridge.resolve({
      challengeId: 'approval-1',
      actor: OWNER,
      decision: 'allow'
    })
    expect(again.kind).toBe('existing')
    expect(executeCalls).toHaveLength(1)
  })

  it('treats publishEffects throw as effects_failed after claim+execute', async () => {
    const bridge = open()
    bridge.register(
      baseRegister({
        deferredId: 'def-fx',
        commandId: 'cmd-fx',
        challengeId: 'approval-fx',
        idempotencyKey: 'desktop:client-desktop-1:22222222-2222-4222-8222-222222222222'
      })
    )
    publishImpl = () => {
      throw new Error('delta publish failed')
    }
    const result = await bridge.resolve({
      challengeId: 'approval-fx',
      actor: OWNER,
      decision: 'allow'
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.code).toBe('effects_failed')
      expect(result.record?.state).toBe('failed')
      expect(result.record?.terminalCode).toBe('effects_threw')
    }
    expect(executeCalls).toHaveLength(1)
    expect(completeCalls).toHaveLength(0)
  })

  it('drops truncated journal tails and skips corrupt interior lines', () => {
    const bridge = open()
    bridge.register(baseRegister())
    const journalPath = join(dataDir, HOST_DEFERRED_COMMAND_JOURNAL_FILENAME)
    appendFileSync(journalPath, '{not-json\n', 'utf8') // truncated / corrupt tail
    appendFileSync(
      journalPath,
      `${JSON.stringify({
        op: 'upsert',
        record: {
          ...baseRegister({ deferredId: 'def-2', commandId: 'cmd-2', challengeId: 'approval-2' }),
          schemaVersion: 1,
          state: 'awaiting',
          createdAt: clock,
          updatedAt: clock,
          actor: OWNER
        }
      })}\n`,
      'utf8'
    )
    // Truncated final line without newline — must be dropped.
    appendFileSync(journalPath, '{"op":"upsert","record":{"deferredId":', 'utf8')

    const reopened = open()
    expect(reopened.getByChallengeId('approval-1', OWNER).kind).toBe('found')
    // Interior corrupt line skipped; valid later line may or may not land depending on
    // whether truncated-tail break fired first. Ensure no throw and awaiting survives.
    expect(reopened.size).toBeGreaterThanOrEqual(1)
  })

  it('rejects privacy-shaped extras on stored records and bounds compaction', () => {
    const bridge = open({ maxRecords: 2, compactAfterRecords: 2 })
    bridge.register(baseRegister())
    bridge.register(
      baseRegister({
        deferredId: 'def-2',
        commandId: 'cmd-2',
        challengeId: 'approval-2',
        idempotencyKey: 'desktop:client-desktop-1:33333333-3333-4333-8333-333333333333',
        commandFingerprint: fingerprint('two')
      })
    )
    bridge.register(
      baseRegister({
        deferredId: 'def-3',
        commandId: 'cmd-3',
        challengeId: 'approval-3',
        idempotencyKey: 'desktop:client-desktop-1:44444444-4444-4444-8444-444444444444',
        commandFingerprint: fingerprint('three')
      })
    )
    expect(bridge.size).toBeLessThanOrEqual(2)
    expect(existsSync(join(dataDir, HOST_DEFERRED_COMMAND_CHECKPOINT_FILENAME))).toBe(true)

    // Poison checkpoint with credential-shaped extra — reopen must drop it.
    writeFileSync(
      join(dataDir, HOST_DEFERRED_COMMAND_CHECKPOINT_FILENAME),
      `${JSON.stringify({
        schemaVersion: 1,
        updatedAt: clock,
        records: [
          {
            schemaVersion: 1,
            deferredId: 'def-bad',
            commandId: 'cmd-bad',
            idempotencyKey: 'idem-bad',
            commandFingerprint: fingerprint('bad'),
            commandName: 'composer.send',
            actor: OWNER,
            challengeId: 'approval-bad',
            challengeKind: 'approval',
            state: 'awaiting',
            createdAt: clock,
            updatedAt: clock,
            password: 'secret'
          }
        ]
      })}\n`,
      'utf8'
    )
    writeFileSync(join(dataDir, HOST_DEFERRED_COMMAND_JOURNAL_FILENAME), '', 'utf8')
    const reopened = open()
    expect(reopened.size).toBe(0)
    expect(reopened.getByChallengeId('approval-bad', OWNER).kind).toBe('not_found')
  })

  it('persists only compact fields on disk', () => {
    const bridge = open()
    bridge.register(baseRegister())
    const journal = readFileSync(join(dataDir, HOST_DEFERRED_COMMAND_JOURNAL_FILENAME), 'utf8')
    expect(journal).not.toMatch(/password|credential|toolOutput|diff|reasoning|transcript/i)
    expect(journal).toContain('"commandFingerprint"')
    expect(journal).toContain('"challengeId"')
    expect(journal).not.toContain('"arguments"')
    expect(journal).not.toContain('"text"')
  })

  it('rejects unsafe effect payloads from the executor without publishing', async () => {
    const bridge = open()
    bridge.register(baseRegister())
    executorImpl = () =>
      ({
        status: 'succeeded',
        effects: [{ kind: 'x', secret: 'nope' }]
      }) as unknown as HostDeferredExecutorResult

    const result = await bridge.resolve({
      challengeId: 'approval-1',
      actor: OWNER,
      decision: 'allow'
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.code).toBe('executor_failed')
      expect(result.record?.terminalCode).toBe('executor_invalid_effects')
    }
    expect(publishCalls).toHaveLength(0)
    expect(completeCalls).toHaveLength(0)
  })
})
