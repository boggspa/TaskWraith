import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  decodeHostCommandReceipt,
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand,
  type HostHealthProjection
} from '../../shared/hostProtocol'
import {
  AppStoreHostAuthority,
  type AppStoreHostAuthorityOptions,
  type AppStoreHostAuthorityPorts,
  type AppStoreHostAuthoritySnapshotDonorFamilies,
  type HostDeferredAskPorts
} from './AppStoreHostAuthority'
import { hostAuthorityReceiptResultHasBody, type HostAuthorityCallContext } from './HostAuthority'
import { fingerprintHostCommand } from './HostCommandFingerprint'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'

const ACTOR_A: HostActorIdentity = {
  actorId: 'actor-a',
  clientId: 'client-a',
  clientClass: 'desktop'
}

const ACTOR_B: HostActorIdentity = {
  actorId: 'actor-b',
  clientId: 'client-b',
  clientClass: 'tui'
}

const CLIENT_A: HostAuthenticatedClientIdentity = {
  clientId: 'client-a',
  clientClass: 'desktop',
  clientVersion: '1.9.2'
}

const NOW = '2026-08-03T22:10:00.000Z'

const DEFERRED_COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const DEFERRED_IDEMPOTENCY_KEY = 'desktop:client-a:22222222-2222-4222-8222-222222222222'

function makeDeferredCommand(): HostCommand {
  return makeCommand({
    commandId: DEFERRED_COMMAND_ID,
    idempotencyKey: DEFERRED_IDEMPOTENCY_KEY,
    actor: ACTOR_A
  })
}

function contextFor(
  actor: HostActorIdentity,
  client?: HostAuthenticatedClientIdentity
): HostAuthorityCallContext {
  return {
    actor,
    client:
      client ??
      ({
        clientId: actor.clientId,
        clientClass: actor.clientClass,
        clientVersion: 'test'
      } satisfies HostAuthenticatedClientIdentity)
  }
}

function makeCommand(
  overrides: Partial<HostCommand> & Pick<HostCommand, 'commandId' | 'idempotencyKey' | 'actor'>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    name: 'thread.select',
    target: { threadId: 'thread-default' },
    arguments: {},
    issuedAt: NOW,
    ...overrides
  }
}

function donorFamilies(
  overrides: Partial<AppStoreHostAuthoritySnapshotDonorFamilies> = {}
): AppStoreHostAuthoritySnapshotDonorFamilies {
  return {
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    workspaces: [
      {
        id: 'ws-1',
        name: 'AGBench',
        path: '/tmp/ws',
        pinned: true,
        updatedAt: 1
      }
    ],
    threads: [],
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
    warnings: [],
    ...overrides
  }
}

describe('AppStoreHostAuthority', () => {
  let hostDataDir: string
  let runtime: HostRuntimeBootstrap
  let executorCalls: number
  let shutdownCalls: number
  let health: HostHealthProjection
  let ports: AppStoreHostAuthorityPorts

  beforeEach(() => {
    hostDataDir = mkdtempSync(join(tmpdir(), 'appstore-host-auth-'))
    runtime = new HostRuntimeBootstrap({
      hostDataDir,
      delta: { now: () => NOW },
      receipts: { now: () => NOW }
    })
    executorCalls = 0
    shutdownCalls = 0
    health = {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    }
    ports = {
      runtime,
      snapshotDonor: () => donorFamilies(),
      authorityEvaluator: () => ({ decision: 'allowed', reason: 'test allow' }),
      commandExecutor: () => {
        executorCalls += 1
        return { status: 'succeeded', resultSummary: 'pong' }
      },
      healthProvider: () => health,
      onShutdown: () => {
        shutdownCalls += 1
      }
    }
  })

  afterEach(() => {
    rmSync(hostDataDir, { recursive: true, force: true })
  })

  function open(
    overrides: Omit<Partial<AppStoreHostAuthorityOptions>, 'ports'> & {
      ports?: Partial<AppStoreHostAuthorityPorts>
    } = {}
  ): AppStoreHostAuthority {
    return new AppStoreHostAuthority({
      mode: 'in-process-migration',
      activationPermit: { hostOwnedStateMayHaveAdvanced: false },
      now: () => NOW,
      ...overrides,
      ports: { ...ports, ...(overrides.ports ?? {}) }
    })
  }

  it('rejects construction without migration mode / pre-cutover permit', () => {
    expect(
      () =>
        new AppStoreHostAuthority({
          mode: 'dedicated-host' as 'in-process-migration',
          activationPermit: { hostOwnedStateMayHaveAdvanced: false },
          ports
        })
    ).toThrow(/in-process-migration/)

    expect(
      () =>
        new AppStoreHostAuthority({
          mode: 'in-process-migration',
          activationPermit: { hostOwnedStateMayHaveAdvanced: true } as never,
          ports
        })
    ).toThrow(/pre-cutover|hostOwnedStateMayHaveAdvanced/)

    expect(
      () =>
        new AppStoreHostAuthority({
          mode: 'in-process-migration',
          activationPermit: undefined as never,
          ports
        })
    ).toThrow(/pre-cutover|activation permit/)
  })

  it('does not call ports when construction is fenced', () => {
    const snapshotDonor = vi.fn(() => donorFamilies())
    const authorityEvaluator = vi.fn(() => ({ decision: 'allowed' as const }))
    const commandExecutor = vi.fn(() => ({ status: 'succeeded' as const }))
    const healthProvider = vi.fn(() => health)
    const onShutdown = vi.fn()
    expect(
      () =>
        new AppStoreHostAuthority({
          mode: 'in-process-migration',
          activationPermit: { hostOwnedStateMayHaveAdvanced: true } as never,
          ports: {
            runtime,
            snapshotDonor,
            authorityEvaluator,
            commandExecutor,
            healthProvider,
            onShutdown
          }
        })
    ).toThrow()
    expect(snapshotDonor).not.toHaveBeenCalled()
    expect(authorityEvaluator).not.toHaveBeenCalled()
    expect(commandExecutor).not.toHaveBeenCalled()
    expect(healthProvider).not.toHaveBeenCalled()
    expect(onShutdown).not.toHaveBeenCalled()
  })

  it('requires exact client/actor binding on every operation', async () => {
    const authority = open()
    const mismatched = {
      actor: ACTOR_A,
      client: { ...CLIENT_A, clientId: 'other-client' }
    }
    expect(await authority.health(mismatched)).toEqual({ ok: false, error: 'invalid_lookup' })
    expect(await authority.snapshot(mismatched)).toEqual({ ok: false, error: 'invalid_lookup' })
    expect(await authority.deltas(mismatched, { generation: 1, cursor: 0 })).toEqual({
      ok: false,
      error: 'invalid_lookup'
    })
    expect(
      await authority.command(
        mismatched,
        makeCommand({ commandId: 'c1', idempotencyKey: 'k1', actor: ACTOR_A })
      )
    ).toEqual({ ok: false, error: 'invalid_lookup' })
    expect(executorCalls).toBe(0)
  })

  it('rejects all reserved read aliases before actor denial, evaluation, receipts, or execution', async () => {
    const authorityEvaluator = vi.fn(() => ({ decision: 'allowed' as const }))
    const commandExecutor = vi.fn(() => ({ status: 'succeeded' as const }))
    const authority = open({
      ports: {
        authorityEvaluator,
        commandExecutor
      }
    })
    const aliases: ReadonlyArray<Pick<HostCommand, 'name' | 'target' | 'arguments'>> = [
      { name: 'snapshot.get' as const, target: {}, arguments: {} },
      {
        name: 'deltas.since' as const,
        target: {},
        arguments: { generation: 1, cursor: 0 }
      },
      {
        name: 'receipt.lookup' as const,
        target: { commandId: 'lookup-command' },
        arguments: {}
      },
      { name: 'ping' as const, target: {}, arguments: {} }
    ]

    for (const [index, alias] of aliases.entries()) {
      const result = await authority.command(
        contextFor(ACTOR_A, CLIENT_A),
        makeCommand({
          commandId: `read-${index}`,
          idempotencyKey: `read-key-${index}`,
          actor: ACTOR_B,
          ...alias
        })
      )
      expect(result, alias.name).toEqual({ ok: false, error: 'invalid_lookup' })
    }

    expect(authorityEvaluator).not.toHaveBeenCalled()
    expect(commandExecutor).not.toHaveBeenCalled()
    expect(runtime.receiptStore.size).toBe(0)
  })

  it('orders the read-alias gate after decode and before every mutation-side effect', () => {
    const source = readFileSync(join(__dirname, 'AppStoreHostAuthority.ts'), 'utf8')
    const commandStart = source.indexOf('  async command(')
    const commandEnd = source.indexOf('  /**\n   * Persist a denial', commandStart)
    const commandBody = source.slice(commandStart, commandEnd)
    const orderedNeedles = [
      'decodeHostCommand(command)',
      'parseGovernedMutationCommandName(hostCommand.name)',
      'hostAuthorityCommandActorMatchesContext(context, hostCommand)',
      'fingerprintHostCommand(hostCommand)',
      'this.authorityEvaluator(hostCommand, context)',
      'this.runtime.receiptStore.begin({',
      'this.commandExecutor(hostCommand, context)'
    ]
    const positions = orderedNeedles.map((needle) => commandBody.indexOf(needle))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('injects runtime-only position and overrides donor position smuggling', async () => {
    runtime.deltaStore.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 't1',
      payload: { title: 'x' }
    })
    const authority = open({
      ports: {
        snapshotDonor: () =>
          ({
            ...donorFamilies(),
            // Smuggled donor position must be ignored.
            position: {
              generation: 99,
              cursor: 999,
              freshness: 'cached',
              generatedAt: '1999-01-01T00:00:00.000Z'
            },
            recovery: {
              reopenStatus: 'unknown',
              lastGeneration: 99,
              lastCursor: 999
            }
          }) as unknown as AppStoreHostAuthoritySnapshotDonorFamilies
      }
    })
    const result = await authority.snapshot(contextFor(ACTOR_A, CLIENT_A), {
      generation: 1,
      cursor: 0
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.generation).toBe(1)
    expect(result.value.cursor).toBe(1)
    expect(result.value.freshness).toBe('live')
    expect(result.value.generatedAt).toBe(NOW)
    expect(result.value.recovery.lastGeneration).toBe(1)
    expect(result.value.recovery.lastCursor).toBe(1)
    expect(result.value.recovery.reopenStatus).toBe('clean')
    // Snapshot remains coherent even when caller cursor differs.
    expect(result.value.workspaces[0]?.id).toBe('ws-1')
  })

  it('fails closed when donor families are missing or privacy-unsafe', async () => {
    const missing = open({
      ports: {
        snapshotDonor: () => {
          const base = donorFamilies()
          // omit workspaces
          const { workspaces: _w, ...rest } = base
          return rest as AppStoreHostAuthoritySnapshotDonorFamilies
        }
      }
    })
    expect(await missing.snapshot(contextFor(ACTOR_A, CLIENT_A))).toEqual({
      ok: false,
      error: 'host_unavailable'
    })

    const unsafe = open({
      ports: {
        snapshotDonor: () =>
          donorFamilies({
            warnings: [
              {
                warningId: 'w1',
                severity: 'info',
                code: 'note',
                message: 'sk-ant-api03-secret-token-value',
                at: 1
              }
            ]
          })
      }
    })
    expect(await unsafe.snapshot(contextFor(ACTOR_A, CLIENT_A))).toEqual({
      ok: false,
      error: 'host_unavailable'
    })
  })

  it('delegates deltas to runtime delta store including resnapshot', async () => {
    const authority = open()
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    runtime.deltaStore.append({ kind: 'upsert', family: 'warning', entityId: 'w1' })
    const deltas = await authority.deltas(ctx, { generation: 1, cursor: 0 })
    expect(deltas.ok).toBe(true)
    if (!deltas.ok) return
    expect(deltas.value.kind).toBe('deltas')
    if (deltas.value.kind !== 'deltas') return
    expect(deltas.value.toCursor).toBe(1)
    expect(deltas.value.deltas).toHaveLength(1)

    runtime.deltaStore.resetGeneration('fence')
    const resnapshot = await authority.deltas(ctx, { generation: 1, cursor: 1 })
    expect(resnapshot.ok).toBe(true)
    if (!resnapshot.ok) return
    expect(resnapshot.value).toMatchObject({
      kind: 'full_resnapshot_required',
      reason: 'generation_reset'
    })
  })

  it('keeps receipt lookup body-free on miss / mismatch / incomplete', async () => {
    const authority = open()
    const owner = contextFor(ACTOR_A, CLIENT_A)
    const other = contextFor(ACTOR_B)
    const cmd = makeCommand({ commandId: 'owned', idempotencyKey: 'owned-key', actor: ACTOR_A })
    const created = await authority.command(owner, cmd)
    expect(created.ok).toBe(true)

    const miss = await authority.receipt(owner, { commandId: 'missing' })
    expect(miss).toEqual({ ok: true, outcome: 'not_found' })
    expect(hostAuthorityReceiptResultHasBody(miss)).toBe(false)

    const mismatch = await authority.receipt(other, { commandId: 'owned' })
    expect(mismatch).toEqual({ ok: true, outcome: 'actor_mismatch' })
    expect('receipt' in mismatch).toBe(false)

    const incomplete = await authority.receipt(
      {
        actor: { actorId: '', clientId: 'x', clientClass: 'desktop' },
        client: CLIENT_A
      },
      { commandId: 'owned' }
    )
    expect(incomplete).toEqual({ ok: true, outcome: 'incomplete' })

    const found = await authority.receipt(owner, { idempotencyKey: 'owned-key' })
    expect(found.ok && found.outcome === 'found').toBe(true)
    if (!found.ok || found.outcome !== 'found') return
    expect(decodeHostCommandReceipt(found.receipt).ok).toBe(true)
    expect(found.receipt).not.toHaveProperty('target')
    expect(JSON.stringify(found.receipt)).not.toMatch(/secret|sk-ant-|password/i)
  })

  it('exact replay returns original and never re-executes', async () => {
    const authority = open()
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    const cmd = makeCommand({ commandId: 'replay-1', idempotencyKey: 'replay-key', actor: ACTOR_A })
    const first = await authority.command(ctx, cmd)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.status).toBe('succeeded')
    expect(executorCalls).toBe(1)

    const second = await authority.command(ctx, cmd)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.commandId).toBe(first.value.commandId)
    expect(second.value.status).toBe('succeeded')
    expect(second.value.commandFingerprint).toBe(first.value.commandFingerprint)
    expect(executorCalls).toBe(1)
  })

  it('runs typed deferred S2-S5 in durable order and projects the pending ask last', async () => {
    const events: string[] = []
    let putInput: Parameters<HostDeferredAskPorts['envelopeStorePut']>[0] | undefined
    let registerInput: Parameters<HostDeferredAskPorts['bridgeRegister']>[0] | undefined
    const envelopeStorePut = vi.fn(
      async (input: Parameters<HostDeferredAskPorts['envelopeStorePut']>[0]) => {
        events.push('put')
        putInput = input
        return { kind: 'created' as const }
      }
    )
    const bridgeRegister = vi.fn(
      async (input: Parameters<HostDeferredAskPorts['bridgeRegister']>[0]) => {
        events.push('register')
        registerInput = input
        return { kind: 'created' as const, record: {} as never }
      }
    )
    const authority = open({
      ports: {
        authorityEvaluator: () => ({ decision: 'deferred', challengeKind: 'approval' }),
        deferredAsk: { envelopeStorePut, bridgeRegister }
      }
    })

    const result = await authority.command(contextFor(ACTOR_A, CLIENT_A), makeDeferredCommand())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('pending')
    expect(events).toEqual(['put', 'register'])
    expect(putInput).toBeDefined()
    expect(registerInput).toBeDefined()
    if (!putInput || !registerInput) return
    expect(putInput.deferredId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(putInput.challengeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(putInput.deferredId).toBe(registerInput.deferredId)
    expect(putInput.challengeId).toBe(registerInput.challengeId)
    expect(putInput.challengeKind).toBe('approval')
    expect(registerInput.commandId).toBe(DEFERRED_COMMAND_ID)
    expect(registerInput.idempotencyKey).toBe(DEFERRED_IDEMPOTENCY_KEY)
    expect(registerInput.actor).toEqual(ACTOR_A)
    expect(executorCalls).toBe(0)
  })

  it('fails closed on an untyped deferred ask without creating envelope or bridge state', async () => {
    const envelopeStorePut = vi.fn()
    const bridgeRegister = vi.fn()
    const authority = open({
      ports: {
        authorityEvaluator: () => ({ decision: 'deferred' }),
        deferredAsk: { envelopeStorePut, bridgeRegister }
      }
    })

    const result = await authority.command(contextFor(ACTOR_A, CLIENT_A), makeDeferredCommand())

    expect(result).toEqual({ ok: false, error: 'host_unavailable' })
    expect(envelopeStorePut).not.toHaveBeenCalled()
    expect(bridgeRegister).not.toHaveBeenCalled()
    expect(executorCalls).toBe(0)
    const receipt = runtime.receiptStore.getByCommandId(DEFERRED_COMMAND_ID, ACTOR_A)
    expect(receipt.kind).toBe('found')
    if (receipt.kind !== 'found') return
    expect(receipt.receipt.status).toBe('indeterminate')
    expect(receipt.receipt.errorCode).toBe('deferred_envelope_unavailable')
  })

  it('marks the receipt indeterminate when envelope persistence fails and never registers the bridge', async () => {
    const envelopeStorePut = vi.fn(
      async (_input: Parameters<HostDeferredAskPorts['envelopeStorePut']>[0]) => ({
        kind: 'conflict' as const,
        code: 'command_id_collision' as const
      })
    )
    const bridgeRegister = vi.fn()
    const authority = open({
      ports: {
        authorityEvaluator: () => ({ decision: 'deferred', challengeKind: 'question' }),
        deferredAsk: { envelopeStorePut, bridgeRegister }
      }
    })

    const result = await authority.command(contextFor(ACTOR_A, CLIENT_A), makeDeferredCommand())

    expect(result).toEqual({ ok: false, error: 'host_unavailable' })
    expect(envelopeStorePut).toHaveBeenCalledTimes(1)
    expect(bridgeRegister).not.toHaveBeenCalled()
    expect(executorCalls).toBe(0)
    const receipt = runtime.receiptStore.getByCommandId(DEFERRED_COMMAND_ID, ACTOR_A)
    expect(receipt.kind).toBe('found')
    if (receipt.kind !== 'found') return
    expect(receipt.receipt.errorCode).toBe('deferred_envelope_unavailable')
  })

  it('marks the receipt indeterminate when bridge registration fails after envelope storage', async () => {
    const envelopeStorePut = vi.fn(
      async (_input: Parameters<HostDeferredAskPorts['envelopeStorePut']>[0]) => ({
        kind: 'created' as const
      })
    )
    const bridgeRegister = vi.fn(
      async (_input: Parameters<HostDeferredAskPorts['bridgeRegister']>[0]) => ({
        kind: 'conflict' as const,
        reason: 'command_mismatch' as const
      })
    )
    const authority = open({
      ports: {
        authorityEvaluator: () => ({ decision: 'deferred', challengeKind: 'approval' }),
        deferredAsk: { envelopeStorePut, bridgeRegister }
      }
    })

    const result = await authority.command(contextFor(ACTOR_A, CLIENT_A), makeDeferredCommand())

    expect(result).toEqual({ ok: false, error: 'host_unavailable' })
    expect(envelopeStorePut).toHaveBeenCalledTimes(1)
    expect(bridgeRegister).toHaveBeenCalledTimes(1)
    expect(executorCalls).toBe(0)
    const receipt = runtime.receiptStore.getByCommandId(DEFERRED_COMMAND_ID, ACTOR_A)
    expect(receipt.kind).toBe('found')
    if (receipt.kind !== 'found') return
    expect(receipt.receipt.errorCode).toBe('deferred_envelope_unavailable')
  })

  it('replay never re-puts or re-registers a deferred command', async () => {
    const envelopeStorePut = vi.fn(
      async (_input: Parameters<HostDeferredAskPorts['envelopeStorePut']>[0]) => ({
        kind: 'created' as const
      })
    )
    const bridgeRegister = vi.fn(
      async (_input: Parameters<HostDeferredAskPorts['bridgeRegister']>[0]) => ({
        kind: 'created' as const,
        record: {} as never
      })
    )
    const authority = open({
      ports: {
        authorityEvaluator: () => ({ decision: 'deferred', challengeKind: 'question' }),
        deferredAsk: { envelopeStorePut, bridgeRegister }
      }
    })
    const command = makeDeferredCommand()

    const first = await authority.command(contextFor(ACTOR_A, CLIENT_A), command)
    const second = await authority.command(contextFor(ACTOR_A, CLIENT_A), command)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(envelopeStorePut).toHaveBeenCalledTimes(1)
    expect(bridgeRegister).toHaveBeenCalledTimes(1)
    expect(executorCalls).toBe(0)
  })

  it('allowed / denied / deferred authority paths', async () => {
    const ctx = contextFor(ACTOR_A, CLIENT_A)

    const allowed = open()
    const ok = await allowed.command(
      ctx,
      makeCommand({ commandId: 'allow-1', idempotencyKey: 'allow-k', actor: ACTOR_A })
    )
    expect(ok.ok && ok.value.status === 'succeeded').toBe(true)
    expect(executorCalls).toBe(1)

    const deniedAuth = open({
      ports: {
        authorityEvaluator: () => ({ decision: 'denied', reason: 'policy deny' })
      }
    })
    const denied = await deniedAuth.command(
      ctx,
      makeCommand({ commandId: 'deny-1', idempotencyKey: 'deny-k', actor: ACTOR_A })
    )
    expect(denied.ok).toBe(true)
    if (!denied.ok) return
    expect(denied.value.status).toBe('denied')
    expect(denied.value.authority).toEqual({ decision: 'deny', reason: 'policy deny' })
    expect(executorCalls).toBe(1) // unchanged

    const deferredAuth = open({
      ports: {
        authorityEvaluator: () => ({ decision: 'deferred', reason: 'ask user' })
      }
    })
    const deferred = await deferredAuth.command(
      ctx,
      makeCommand({ commandId: 'ask-1', idempotencyKey: 'ask-k', actor: ACTOR_A })
    )
    expect(deferred.ok).toBe(true)
    if (!deferred.ok) return
    expect(deferred.value.status).toBe('pending')
    expect(deferred.value.authority.decision).toBe('ask')
    expect(executorCalls).toBe(1)
  })

  it('idempotency conflict returns projected conflict without exposing foreign body', async () => {
    const authority = open()
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    const first = makeCommand({
      commandId: 'idem-a',
      idempotencyKey: 'shared',
      actor: ACTOR_A,
      arguments: {}
    })
    const firstResult = await authority.command(ctx, first)
    expect(firstResult.ok).toBe(true)

    const second = makeCommand({
      commandId: 'idem-b',
      idempotencyKey: 'shared',
      actor: ACTOR_A,
      name: 'thread.select',
      target: { threadId: 'thread-1' },
      arguments: {}
    })
    const conflict = await authority.command(ctx, second)
    expect(conflict.ok).toBe(true)
    if (!conflict.ok) return
    expect(conflict.value.status).toBe('conflict')
    expect(conflict.value.commandId).toBe('idem-b')
    expect(conflict.value.conflictCommandId).toBe('idem-a')
    expect(conflict.value).not.toHaveProperty('target')
    // Original remains sole idempotency owner.
    const byKey = await authority.receipt(ctx, { idempotencyKey: 'shared' })
    expect(byKey.ok && byKey.outcome === 'found' && byKey.receipt.commandId === 'idem-a').toBe(true)
    expect(executorCalls).toBe(1)
  })

  it('command-id mismatch fails closed without executing', async () => {
    const authority = open()
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    await authority.command(
      ctx,
      makeCommand({ commandId: 'same-id', idempotencyKey: 'k-a', actor: ACTOR_A })
    )
    const mismatch = await authority.command(
      ctx,
      makeCommand({
        commandId: 'same-id',
        idempotencyKey: 'k-b',
        actor: ACTOR_A,
        name: 'thread.select',
        target: { threadId: 't1' }
      })
    )
    expect(mismatch).toEqual({ ok: false, error: 'host_unavailable' })
    expect(executorCalls).toBe(1)
  })

  it('actor spoof denial binds to context.actor and never executes', async () => {
    const authority = open()
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    const spoofed = makeCommand({
      commandId: 'spoof-1',
      idempotencyKey: 'spoof-k',
      actor: ACTOR_B
    })
    const result = await authority.command(ctx, spoofed)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('denied')
    expect(result.value.actor).toEqual(ACTOR_A)
    expect(result.value.authority.decision).toBe('deny')
    expect(executorCalls).toBe(0)

    const found = await authority.receipt(ctx, { commandId: 'spoof-1' })
    expect(found.ok && found.outcome === 'found').toBe(true)
    if (!found.ok || found.outcome !== 'found') return
    expect(found.receipt.actor).toEqual(ACTOR_A)

    // Occupied id: second spoof with same commandId fails body-free.
    const occupied = await authority.command(
      ctx,
      makeCommand({
        commandId: 'spoof-1',
        idempotencyKey: 'spoof-other',
        actor: ACTOR_B,
        name: 'thread.select',
        target: { threadId: 't9' }
      })
    )
    expect(occupied).toEqual({ ok: false, error: 'host_unavailable' })
    expect(executorCalls).toBe(0)
  })

  it('sanitizes executor throws into bounded failed receipts', async () => {
    const authority = open({
      ports: {
        commandExecutor: () => {
          executorCalls += 1
          throw new Error('SECRET_TOKEN=sk-ant-leak stack trace')
        }
      }
    })
    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({ commandId: 'boom', idempotencyKey: 'boom-k', actor: ACTOR_A })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('failed')
    expect(result.value.errorCode).toBe('executor_failed')
    expect(result.value.errorMessage).toBe('command executor failed')
    expect(JSON.stringify(result.value)).not.toMatch(/SECRET_TOKEN|sk-ant|stack/i)
  })

  it('shutdown flushes runtime, is idempotent, and never auto-restarts', async () => {
    const authority = open()
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    runtime.deltaStore.append({ kind: 'upsert', family: 'artifact', entityId: 'a1' })

    const first = await authority.shutdown(ctx)
    expect(first).toEqual({ ok: true, value: { stopped: true, alreadyStopped: false } })
    expect(shutdownCalls).toBe(1)

    const second = await authority.shutdown(ctx)
    expect(second).toEqual({ ok: true, value: { stopped: true, alreadyStopped: true } })
    expect(shutdownCalls).toBe(1)

    expect(await authority.health(ctx)).toEqual({ ok: false, error: 'shutting_down' })
    expect(await authority.snapshot(ctx)).toEqual({ ok: false, error: 'shutting_down' })
    expect(
      await authority.command(
        ctx,
        makeCommand({ commandId: 'after', idempotencyKey: 'after', actor: ACTOR_A })
      )
    ).toEqual({ ok: false, error: 'shutting_down' })
    expect(executorCalls).toBe(0)

    // Durable flush survived.
    const reopened = new HostRuntimeBootstrap({ hostDataDir })
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 1 })
  })

  it('health returns injected live projection only while active', async () => {
    const authority = open()
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    const live = await authority.health(ctx)
    expect(live).toEqual({ ok: true, value: health })
    await authority.shutdown(ctx)
    expect(await authority.health(ctx)).toEqual({ ok: false, error: 'shutting_down' })
  })

  it('projected command receipts pass shared validators and omit sentinels', async () => {
    const authority = open()
    const cmd = makeCommand({ commandId: 'valid-1', idempotencyKey: 'valid-k', actor: ACTOR_A })
    const result = await authority.command(contextFor(ACTOR_A, CLIENT_A), cmd)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(decodeHostCommandReceipt(result.value).ok).toBe(true)
    expect(result.value.commandFingerprint).toBe(fingerprintHostCommand(cmd).fingerprint)
    expect(result.value).not.toHaveProperty('target')
    expect(result.value).not.toHaveProperty('policy')
    expect(result.value).not.toHaveProperty('recoveryState')
  })
})
