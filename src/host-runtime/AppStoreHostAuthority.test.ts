import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  decodeHostCommandReceipt,
  HOST_PROTOCOL_MAX_COLLECTION,
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand,
  type HostHealthProjection
} from '../shared/hostProtocol'
import type { HostProviderStatusProjection } from '../shared/hostSetupProtocol'
import type { HostWorkspaceGitReadParams } from '../shared/hostProtocolTransport'
import { ThreadCatalogueRequestError } from '../shared/threadCatalogueRequestError'
import {
  AppStoreHostAuthority,
  createHostStandaloneAuthorityActivationPermit,
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

  it('requires a lease-minted standalone permit and rejects deferred/no-longer-held calls before receipts', async () => {
    let held = true
    const lease = {
      assertHeld: vi.fn(() => {
        if (!held) throw new Error('lease lost')
      })
    }
    const permit = createHostStandaloneAuthorityActivationPermit(lease)
    const authority = new AppStoreHostAuthority({
      mode: 'standalone',
      activationPermit: permit,
      now: () => NOW,
      ports: {
        ...ports,
        authorityEvaluator: () => ({ decision: 'deferred' })
      }
    })
    const deferred = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'standalone-deferred',
        idempotencyKey: 'standalone-deferred-key',
        actor: ACTOR_A
      })
    )
    expect(deferred).toEqual({ ok: false, error: 'host_unavailable' })
    expect(runtime.receiptStore.size).toBe(0)

    held = false
    const lost = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'standalone-lost',
        idempotencyKey: 'standalone-lost-key',
        actor: ACTOR_A
      })
    )
    expect(lost).toEqual({ ok: false, error: 'host_unavailable' })
    expect(runtime.receiptStore.size).toBe(0)
    await expect(authority.health(contextFor(ACTOR_A, CLIENT_A))).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    await expect(
      authority.deltas(contextFor(ACTOR_A, CLIENT_A), { generation: 0, cursor: 0 })
    ).resolves.toEqual({ ok: false, error: 'host_unavailable' })
    await expect(
      authority.receipt(contextFor(ACTOR_A, CLIENT_A), { commandId: 'standalone-command-1' })
    ).resolves.toEqual({ ok: false, error: 'host_unavailable' })
    await expect(authority.shutdown(contextFor(ACTOR_A, CLIENT_A))).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    expect(lease.assertHeld).toHaveBeenCalled()
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
    expect(await authority.threadOffers(mismatched, 'thread-1')).toEqual({
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

  it('serves injected setup/history reads only after the exact context gate and strict decode', async () => {
    const authority = open({
      ports: {
        providerStatusesProvider: () => [{ providerId: 'codex', status: 'ready', label: 'Codex' }],
        providerOffersProvider: (providerId) => ({
          providerId,
          offerRevision: 'revision-1',
          models: [],
          postures: []
        }),
        providerAuthFlowsProvider: () => [],
        providerAuthStatusProvider: (providerId) => ({ providerId, state: 'authenticated' }),
        threadHistoryProvider: (request) => ({
          threadId: request.threadId,
          generation: 1,
          cursor: 0,
          entries: []
        }),
        historySinceProvider: (request) => ({
          kind: 'full_resnapshot_required',
          threadId: request.threadId,
          generation: 1,
          cursor: 0,
          clientGeneration: request.since.generation,
          clientCursor: request.since.cursor,
          reason: 'retention_gap'
        })
      }
    })
    const context = contextFor(ACTOR_A, CLIENT_A)
    await expect(authority.providerStatuses(context)).resolves.toMatchObject({
      ok: true,
      value: [{ providerId: 'codex' }]
    })
    await expect(authority.providerOffers(context, 'codex')).resolves.toMatchObject({
      ok: true,
      value: { providerId: 'codex', offerRevision: 'revision-1' }
    })
    await expect(
      authority.threadHistory(context, { threadId: 'thread-1', limit: 10 })
    ).resolves.toMatchObject({ ok: true, value: { threadId: 'thread-1' } })
    await expect(
      authority.historySince(context, { threadId: 'thread-1', since: { generation: 1, cursor: 0 } })
    ).resolves.toMatchObject({ ok: true, value: { kind: 'full_resnapshot_required' } })
    await expect(
      authority.providerOffers(contextFor(ACTOR_A, { ...CLIENT_A, clientId: 'wrong' }), 'codex')
    ).resolves.toEqual({
      ok: false,
      error: 'invalid_lookup'
    })
  })

  it('fails closed on invalid or identity-mismatched read provider output while preserving shutdown', async () => {
    const authority = open({
      ports: {
        providerStatusesProvider: () =>
          [
            // Deliberately invalid status: the authority must fail closed.
            { providerId: 'codex', status: 'invented', label: 'Codex' }
          ] as unknown as readonly HostProviderStatusProjection[],
        providerOffersProvider: () => ({
          providerId: 'different-provider',
          offerRevision: 'revision-1',
          models: [],
          postures: []
        }),
        providerAuthFlowsProvider: () => [],
        providerAuthStatusProvider: (providerId) => ({ providerId, state: 'authenticated' }),
        threadHistoryProvider: () => ({
          threadId: 'different-thread',
          generation: 1,
          cursor: 0,
          entries: []
        }),
        historySinceProvider: (request) => ({
          kind: 'full_resnapshot_required',
          threadId: request.threadId,
          generation: 1,
          cursor: 0,
          clientGeneration: request.since.generation,
          clientCursor: request.since.cursor,
          reason: 'retention_gap'
        })
      }
    })
    const context = contextFor(ACTOR_A, CLIENT_A)
    await expect(authority.providerStatuses(context)).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    await expect(authority.providerOffers(context, 'codex')).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    await expect(
      authority.threadHistory(context, { threadId: 'thread-1', limit: 10 })
    ).resolves.toEqual({ ok: false, error: 'host_unavailable' })
    await expect(authority.shutdown(context)).resolves.toMatchObject({ ok: true })
    await expect(authority.providerStatuses(context)).resolves.toEqual({
      ok: false,
      error: 'shutting_down'
    })
  })

  it('refuses setup before receipt begin when no dedicated setup executor is injected', async () => {
    const authority = open()
    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'setup-missing-executor',
        idempotencyKey: 'setup-missing-executor-key',
        actor: ACTOR_A,
        name: 'workspace.register',
        target: {},
        arguments: { path: '/workspace' }
      })
    )

    expect(result).toEqual({ ok: false, error: 'host_unavailable' })
    expect(runtime.receiptStore.size).toBe(0)
    expect(executorCalls).toBe(0)
  })

  it('routes setup only through the injected setup executor and persists its resultRef', async () => {
    const bridgeExecutor = vi.fn(() => ({ status: 'succeeded' as const }))
    const setupExecutor = vi.fn(() => ({
      status: 'succeeded' as const,
      resultRef: { kind: 'workspace' as const, workspaceId: 'workspace-1' }
    }))
    const authority = open({
      ports: {
        commandExecutor: bridgeExecutor,
        setupExecutor: { execute: setupExecutor }
      }
    })
    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'setup-executor',
        idempotencyKey: 'setup-executor-key',
        actor: ACTOR_A,
        name: 'workspace.register',
        target: {},
        arguments: { path: '/workspace' }
      })
    )

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'succeeded', resultRef: { kind: 'workspace', workspaceId: 'workspace-1' } }
    })
    expect(setupExecutor).toHaveBeenCalledOnce()
    expect(bridgeExecutor).not.toHaveBeenCalled()
    const replay = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'setup-executor',
        idempotencyKey: 'setup-executor-key',
        actor: ACTOR_A,
        name: 'workspace.register',
        target: {},
        arguments: { path: '/workspace' }
      })
    )
    expect(replay).toMatchObject({
      ok: true,
      value: { resultRef: { kind: 'workspace', workspaceId: 'workspace-1' } }
    })
    expect(setupExecutor).toHaveBeenCalledOnce()
  })

  it('orders the read-alias gate after decode and before every mutation-side effect', () => {
    const source = readFileSync(join(__dirname, 'AppStoreHostAuthority.ts'), 'utf8')
    const commandStart = source.indexOf('  async command(')
    const commandEnd = source.indexOf('  /**\n   * Persist a denial', commandStart)
    const commandBody = source.slice(commandStart, commandEnd)
    const orderedNeedles = [
      'decodeHostCommand(command)',
      'validateHostCommandArguments(decoded.value)',
      'parseGovernedMutationCommandName(hostCommand.name)',
      'parseSetupMutationCommandName(hostCommand.name)',
      'hostAuthorityCommandActorMatchesContext(context, hostCommand)',
      'fingerprintHostCommand(hostCommand)',
      'this.authorityEvaluator(hostCommand, context)',
      'this.runtime.receiptStore.begin({',
      'this.executeAllowedMutation(hostCommand, context, this.commandExecutor)',
      'new HostObservedMutationExecutor({',
      'this.completionCoordinator.complete('
    ]
    const positions = orderedNeedles.map((needle) => commandBody.indexOf(needle))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('keeps the denied path free of observe/complete wiring (byte-identity fence)', () => {
    const source = readFileSync(join(__dirname, 'AppStoreHostAuthority.ts'), 'utf8')
    const deniedStart = source.indexOf("if (evaluation.decision === 'denied')")
    const deferredStart = source.indexOf("if (evaluation.decision === 'deferred')", deniedStart)
    expect(deniedStart).toBeGreaterThan(0)
    expect(deferredStart).toBeGreaterThan(deniedStart)
    const deniedBlock = source.slice(deniedStart, deferredStart)
    expect(deniedBlock).toContain("status: 'denied'")
    expect(deniedBlock).toContain("errorCode: 'authority_denied'")
    expect(deniedBlock).toContain('this.runtime.receiptStore.complete({')
    expect(deniedBlock).not.toMatch(
      /HostObservedMutationExecutor|completionCoordinator|domainPublisher/
    )
  })

  it('allowed path observes once, completes via sole journal, and preserves status passthrough', async () => {
    const authority = open()
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    const before = runtime.getPosition()
    const result = await authority.command(
      ctx,
      makeCommand({ commandId: 'allow-obs-1', idempotencyKey: 'allow-obs-k', actor: ACTOR_A })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('succeeded')
    expect(result.value.resultSummary).toBe('pong')
    expect(executorCalls).toBe(1)
    // Terminal generation/cursor come from the sole journal (begin position when
    // no domain effects were published).
    expect(result.value.generation).toBe(before.generation)
    expect(result.value.cursor).toBe(before.cursor)
  })

  it('executes a thread-record persist when unrelated run rows exceed the public snapshot cap', async () => {
    const threadId = 'thread-release-scale'
    const unrelatedRuns = Array.from({ length: HOST_PROTOCOL_MAX_COLLECTION + 1 }, (_, index) => ({
      runId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      threadId: `thread-unrelated-${index}`,
      providerId: 'codex',
      providerOutcome: 'completed' as const,
      endedAt: index + 1
    }))
    let persisted = false
    const commandExecutor = vi.fn(() => {
      persisted = true
      return { status: 'succeeded' as const, resultSummary: 'thread_record_persisted' }
    })
    const authority = open({
      ports: {
        snapshotDonor: () =>
          donorFamilies({
            threads: [
              {
                id: threadId,
                workspaceId: null,
                title: persisted ? 'Persisted' : 'Before',
                chatKind: 'ensemble',
                archived: false,
                pinned: false,
                updatedAt: persisted ? 2 : 1,
                messageCount: persisted ? 1 : 0
              }
            ],
            runs: unrelatedRuns
          }),
        commandExecutor
      }
    })

    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'release-scale-persist',
        idempotencyKey: 'release-scale-persist-key',
        actor: ACTOR_A,
        name: 'thread.record.persist',
        target: { threadId },
        arguments: {
          transferId: '11111111-1111-4111-8111-111111111111',
          sha256: 'a'.repeat(64),
          byteLength: 1,
          expectedRevision: 0
        }
      })
    )

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'succeeded', resultSummary: 'thread_record_persisted' }
    })
    expect(commandExecutor).toHaveBeenCalledOnce()
    const deltaResult = runtime.deltaStore.since({ generation: 1, cursor: 0 })
    expect(deltaResult).toMatchObject({
      kind: 'deltas',
      deltas: [
        expect.objectContaining({
          kind: 'upsert',
          family: 'thread',
          entityId: threadId,
          payload: expect.objectContaining({ title: 'Persisted' })
        })
      ]
    })
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

  it('returns only canonical thread offers from its injected read port', async () => {
    const threadOffersProvider = vi.fn(() => ({
      threadId: 'thread-1',
      provider: {
        runtimeProvider: 'mistral',
        displayProvider: 'Mistral',
        hueKey: 'mistral',
        accent: '#D44404',
        model: 'devstral-small',
        modelLabel: 'Devstral Small',
        shortCode: 'MST'
      },
      currentModel: 'devstral-small',
      models: [
        {
          id: 'devstral-small',
          label: 'Devstral Small',
          current: true,
          reasoningEfforts: []
        }
      ],
      source: 'curated' as const
    }))
    const authority = open({ ports: { threadOffersProvider } })
    const result = await authority.threadOffers(contextFor(ACTOR_A, CLIENT_A), 'thread-1')

    expect(result).toMatchObject({
      ok: true,
      value: { threadId: 'thread-1', currentModel: 'devstral-small' }
    })
    expect(threadOffersProvider).toHaveBeenCalledWith('thread-1')
    expect(await authority.threadOffers(contextFor(ACTOR_A, CLIENT_A), 'x'.repeat(513))).toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    expect(threadOffersProvider).toHaveBeenCalledTimes(1)
  })

  it('gates and decodes the optional workspace Git read provider', async () => {
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    const gitReadProvider = vi.fn(
      (_context: HostAuthorityCallContext, _request: HostWorkspaceGitReadParams) => ({
        scope: 'status' as const,
        branch: 'main',
        head: 'a'.repeat(40),
        files: [],
        truncated: false
      })
    )
    const authority = open({ ports: { gitReadProvider } })
    await expect(
      authority.gitRead(ctx, { workspaceId: 'workspace-1', scope: 'status' })
    ).resolves.toMatchObject({
      ok: true,
      value: { scope: 'status', branch: 'main', truncated: false }
    })
    expect(gitReadProvider).toHaveBeenCalledWith(ctx, {
      workspaceId: 'workspace-1',
      scope: 'status'
    })

    await expect(
      open().gitRead(ctx, { workspaceId: 'workspace-1', scope: 'status' })
    ).resolves.toEqual({ ok: false, error: 'host_unavailable' })
    await expect(
      open({
        ports: {
          gitReadProvider: () => ({
            scope: 'status',
            branch: 'main',
            head: 'short',
            files: [],
            truncated: false
          })
        }
      }).gitRead(ctx, { workspaceId: 'workspace-1', scope: 'status' })
    ).resolves.toEqual({ ok: false, error: 'host_unavailable' })
  })

  it('fails thread offers closed when its optional provider is absent or mismatched', async () => {
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    expect(await open().threadOffers(ctx, 'thread-1')).toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    const mismatched = open({
      ports: {
        threadOffersProvider: () => ({
          threadId: 'another-thread',
          provider: {
            runtimeProvider: 'codex',
            displayProvider: 'Codex',
            hueKey: 'codex',
            accent: '#705AFF',
            shortCode: 'CDX'
          },
          models: [],
          source: 'curated'
        })
      }
    })
    expect(await mismatched.threadOffers(ctx, 'thread-1')).toEqual({
      ok: false,
      error: 'host_unavailable'
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

  it('promotes executor throws to recoverable indeterminate without leaking throw bodies', async () => {
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
    expect(result.value.status).toBe('indeterminate')
    expect(result.value.errorCode).toBe('deferred_execution_may_have_begun')
    expect(executorCalls).toBe(1)
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

  it('S4b: absent E-first ports keep approval.decide on verbatim H (byte-compat)', async () => {
    const authority = open()
    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'decide-h-1',
        idempotencyKey: 'decide-h-k',
        actor: ACTOR_A,
        name: 'approval.decide',
        target: { approvalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        arguments: { decision: 'accept' }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('succeeded')
    expect(executorCalls).toBe(1)
  })

  it('S4b: not_found falls through to live-Bridge H unchanged', async () => {
    const getByChallengeId = vi.fn(async () => ({ kind: 'not_found' as const }))
    const resolve = vi.fn()
    const authority = open({
      ports: {
        deferredAsk: {
          envelopeStorePut: async () => ({ kind: 'created' as const }),
          bridgeRegister: async () => ({ kind: 'created' as const, record: {} as never }),
          getByChallengeId,
          resolve
        }
      }
    })
    const challengeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'decide-nf-1',
        idempotencyKey: 'decide-nf-k',
        actor: ACTOR_A,
        name: 'approval.decide',
        target: { approvalId: challengeId },
        arguments: { decision: 'accept' }
      })
    )
    expect(result.ok).toBe(true)
    expect(getByChallengeId).toHaveBeenCalledTimes(1)
    expect(resolve).not.toHaveBeenCalled()
    expect(executorCalls).toBe(1)
  })

  it('S4b RED: matched resolve never calls H (double-H-on-match)', async () => {
    const challengeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const originalCommandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const record = {
      schemaVersion: 1 as const,
      deferredId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      commandId: originalCommandId,
      idempotencyKey: 'orig-key',
      commandFingerprint: 'fp',
      commandName: 'thread.select' as const,
      actor: ACTOR_A,
      challengeId,
      challengeKind: 'approval' as const,
      state: 'succeeded' as const,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
      decision: 'allow' as const
    }
    // Seed the original deferred receipt so E-owned projection can return it.
    const originalCmd = makeCommand({
      commandId: originalCommandId,
      idempotencyKey: 'orig-key',
      actor: ACTOR_A
    })
    const seeded = open()
    await seeded.command(contextFor(ACTOR_A, CLIENT_A), originalCmd)
    expect(executorCalls).toBe(1)
    executorCalls = 0

    const getByChallengeId = vi.fn(async () => ({ kind: 'found' as const, record }))
    const resolve = vi.fn(async () => ({ kind: 'completed' as const, record }))
    const authority = open({
      ports: {
        deferredAsk: {
          envelopeStorePut: async () => ({ kind: 'created' as const }),
          bridgeRegister: async () => ({ kind: 'created' as const, record: {} as never }),
          getByChallengeId,
          resolve
        }
      }
    })

    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'decide-match-1',
        idempotencyKey: 'decide-match-k',
        actor: ACTOR_A,
        name: 'approval.decide',
        target: { approvalId: challengeId },
        arguments: { decision: 'accept' }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.commandId).toBe(originalCommandId)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId,
        decision: 'allow',
        actor: ACTOR_A
      })
    )
    expect(executorCalls).toBe(0)
  })

  it('S4b RED: E non-success on match never falls through to H', async () => {
    const challengeId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const record = {
      schemaVersion: 1 as const,
      deferredId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      commandId: '11111111-2222-4333-8444-555555555555',
      idempotencyKey: 'fail-orig',
      commandFingerprint: 'fp',
      commandName: 'thread.select' as const,
      actor: ACTOR_A,
      challengeId,
      challengeKind: 'approval' as const,
      state: 'awaiting' as const,
      createdAt: NOW,
      updatedAt: NOW
    }
    const getByChallengeId = vi.fn(async () => ({ kind: 'found' as const, record }))
    const resolve = vi.fn(async () => ({
      kind: 'failed' as const,
      code: 'executor_failed' as const,
      record
    }))
    const authority = open({
      ports: {
        deferredAsk: {
          envelopeStorePut: async () => ({ kind: 'created' as const }),
          bridgeRegister: async () => ({ kind: 'created' as const, record: {} as never }),
          getByChallengeId,
          resolve
        }
      }
    })

    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'decide-fail-1',
        idempotencyKey: 'decide-fail-k',
        actor: ACTOR_A,
        name: 'approval.decide',
        target: { approvalId: challengeId },
        arguments: { decision: 'decline' }
      })
    )
    expect(result).toEqual({ ok: false, error: 'host_unavailable' })
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ challengeId, decision: 'deny' }))
    expect(executorCalls).toBe(0)
  })

  it('S4b: challengeKind mismatch rejects zero-H and never resolves', async () => {
    const challengeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeffff'
    const record = {
      schemaVersion: 1 as const,
      deferredId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      commandId: '22222222-3333-4444-8555-666666666666',
      idempotencyKey: 'kind-orig',
      commandFingerprint: 'fp',
      commandName: 'thread.select' as const,
      actor: ACTOR_A,
      challengeId,
      challengeKind: 'question' as const,
      state: 'awaiting' as const,
      createdAt: NOW,
      updatedAt: NOW
    }
    const getByChallengeId = vi.fn(async () => ({ kind: 'found' as const, record }))
    const resolve = vi.fn()
    const authority = open({
      ports: {
        deferredAsk: {
          envelopeStorePut: async () => ({ kind: 'created' as const }),
          bridgeRegister: async () => ({ kind: 'created' as const, record: {} as never }),
          getByChallengeId,
          resolve
        }
      }
    })

    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'decide-kind-1',
        idempotencyKey: 'decide-kind-k',
        actor: ACTOR_A,
        name: 'approval.decide',
        target: { approvalId: challengeId },
        arguments: { decision: 'accept' }
      })
    )
    expect(result).toEqual({ ok: false, error: 'invalid_lookup' })
    expect(resolve).not.toHaveBeenCalled()
    expect(executorCalls).toBe(0)
  })

  it('S4b: correlated question.answer answer is body-free non-success, zero H, zero resolve', async () => {
    const challengeId = '33333333-4444-4555-8666-777777777777'
    const record = {
      schemaVersion: 1 as const,
      deferredId: '44444444-5555-4666-8777-888888888888',
      commandId: '55555555-6666-4777-8888-999999999999',
      idempotencyKey: 'q-orig',
      commandFingerprint: 'fp',
      commandName: 'thread.select' as const,
      actor: ACTOR_A,
      challengeId,
      challengeKind: 'question' as const,
      state: 'awaiting' as const,
      createdAt: NOW,
      updatedAt: NOW
    }
    const getByChallengeId = vi.fn(async () => ({ kind: 'found' as const, record }))
    const resolve = vi.fn()
    const authority = open({
      ports: {
        deferredAsk: {
          envelopeStorePut: async () => ({ kind: 'created' as const }),
          bridgeRegister: async () => ({ kind: 'created' as const, record: {} as never }),
          getByChallengeId,
          resolve
        }
      }
    })

    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'q-ans-1',
        idempotencyKey: 'q-ans-k',
        actor: ACTOR_A,
        name: 'question.answer',
        target: { questionId: challengeId },
        arguments: { decision: 'answer', answer: 'hello' }
      })
    )
    expect(result).toEqual({ ok: false, error: 'invalid_lookup' })
    expect(resolve).not.toHaveBeenCalled()
    expect(executorCalls).toBe(0)
  })

  it('S4b: question.answer dismiss maps to cancel on correlated challenge', async () => {
    const challengeId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
    const originalCommandId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
    const record = {
      schemaVersion: 1 as const,
      deferredId: '88888888-9999-4aaa-8bbb-cccccccccccc',
      commandId: originalCommandId,
      idempotencyKey: 'dismiss-orig',
      commandFingerprint: 'fp',
      commandName: 'thread.select' as const,
      actor: ACTOR_A,
      challengeId,
      challengeKind: 'question' as const,
      state: 'cancelled' as const,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
      decision: 'cancel' as const
    }
    // Seed original receipt so E-owned projection can return it.
    await open().command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: originalCommandId,
        idempotencyKey: 'dismiss-orig',
        actor: ACTOR_A
      })
    )
    executorCalls = 0

    const getByChallengeId = vi.fn(async () => ({ kind: 'found' as const, record }))
    const resolve = vi.fn(async () => ({ kind: 'completed' as const, record }))
    const authority = open({
      ports: {
        deferredAsk: {
          envelopeStorePut: async () => ({ kind: 'created' as const }),
          bridgeRegister: async () => ({ kind: 'created' as const, record: {} as never }),
          getByChallengeId,
          resolve
        }
      }
    })

    const result = await authority.command(
      contextFor(ACTOR_A, CLIENT_A),
      makeCommand({
        commandId: 'q-dismiss-1',
        idempotencyKey: 'q-dismiss-k',
        actor: ACTOR_A,
        name: 'question.answer',
        target: { questionId: challengeId },
        arguments: { decision: 'dismiss' }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.commandId).toBe(originalCommandId)
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId, decision: 'cancel' })
    )
    expect(executorCalls).toBe(0)
  })

  it('S4b: acceptForSession/acceptForWorkspace map to allow (scoped-grant honesty)', async () => {
    const challengeId = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
    const record = {
      schemaVersion: 1 as const,
      deferredId: 'aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      commandId: 'bbbb2222-cccc-4ddd-8eee-ffffffffffff',
      idempotencyKey: 'grant-orig',
      commandFingerprint: 'fp',
      commandName: 'thread.select' as const,
      actor: ACTOR_A,
      challengeId,
      challengeKind: 'approval' as const,
      state: 'awaiting' as const,
      createdAt: NOW,
      updatedAt: NOW
    }
    const resolve = vi.fn(async () => ({
      kind: 'failed' as const,
      code: 'executor_failed' as const,
      record
    }))
    const authority = open({
      ports: {
        deferredAsk: {
          envelopeStorePut: async () => ({ kind: 'created' as const }),
          bridgeRegister: async () => ({ kind: 'created' as const, record: {} as never }),
          getByChallengeId: async () => ({ kind: 'found' as const, record }),
          resolve
        }
      }
    })

    for (const decision of ['acceptForSession', 'acceptForWorkspace'] as const) {
      resolve.mockClear()
      executorCalls = 0
      const result = await authority.command(
        contextFor(ACTOR_A, CLIENT_A),
        makeCommand({
          commandId: `grant-${decision}`,
          idempotencyKey: `grant-k-${decision}`,
          actor: ACTOR_A,
          name: 'approval.decide',
          target: { approvalId: challengeId },
          arguments: { decision }
        })
      )
      expect(result, decision).toEqual({ ok: false, error: 'host_unavailable' })
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({ challengeId, decision: 'allow' })
      )
      expect(executorCalls, decision).toBe(0)
    }
  })

  it('rejects deferredAsk when only one of getByChallengeId/resolve is supplied', () => {
    expect(() =>
      open({
        ports: {
          deferredAsk: {
            envelopeStorePut: async () => ({ kind: 'created' as const }),
            bridgeRegister: async () => ({ kind: 'created' as const, record: {} as never }),
            resolve: async () => ({ kind: 'not_found' as const })
          }
        }
      })
    ).toThrow(/complete injected ports/)
  })

  it('preserves a request-local catalogue cause and lane while Host health remains ready', async () => {
    const threadCatalogueProvider = vi.fn(async () => {
      throw new ThreadCatalogueRequestError('source_changed')
    })
    const authority = open({ ports: { threadCatalogueProvider } })

    await expect(
      authority.threadCatalogue(
        contextFor(ACTOR_A, CLIENT_A),
        { method: 'open', chatId: 'moving-chat', mode: 'metadata' },
        { priority: 'background' }
      )
    ).resolves.toEqual({
      ok: true,
      value: { data: null, error: { code: 'source_changed' } }
    })
    expect(threadCatalogueProvider).toHaveBeenCalledWith(
      { method: 'open', chatId: 'moving-chat', mode: 'metadata' },
      { priority: 'background' }
    )
    await expect(authority.health(contextFor(ACTOR_A, CLIENT_A))).resolves.toMatchObject({
      ok: true
    })
  })

  it('keeps unknown reads and all maintenance failures on the legacy Host failure path', async () => {
    const unknown = open({
      ports: {
        threadCatalogueProvider: async () => {
          throw new Error('catalogue database corrupt')
        }
      }
    })
    await expect(
      unknown.threadCatalogue(contextFor(ACTOR_A, CLIENT_A), {
        method: 'summary',
        chatId: 'chat-1'
      })
    ).resolves.toEqual({ ok: false, error: 'host_unavailable' })

    const maintenance = open({
      ports: {
        threadCatalogueMaintenanceProvider: async () => {
          throw new ThreadCatalogueRequestError('source_changed')
        }
      }
    })
    const desktopClient = {
      clientId: TASKWRAITH_DESKTOP_HOST_ACTOR.clientId,
      clientClass: TASKWRAITH_DESKTOP_HOST_ACTOR.clientClass,
      clientVersion: 'test'
    } as const
    await expect(
      maintenance.threadCatalogueMaintenance(
        { actor: TASKWRAITH_DESKTOP_HOST_ACTOR, client: desktopClient },
        { method: 'repair-source', chatId: 'chat-1' }
      )
    ).resolves.toEqual({ ok: false, error: 'host_unavailable' })
  })

  it('queued composer.send returns the pending receipt without occupying the projection queue', async () => {
    let releaseAck!: () => void
    const hungAck = new Promise<{ status: 'succeeded'; resultSummary: string }>((resolve) => {
      releaseAck = () => resolve({ status: 'succeeded', resultSummary: 'run_queued' })
    })
    let queueHeld = false
    const queuedComposerSend = vi.fn(() => hungAck)
    const authority = open({
      ports: {
        runProjectionOperation: async (operation) => {
          queueHeld = true
          return operation()
        },
        commandExecutor: () => {
          throw new Error('legacy observed executor must not run for queued composer.send')
        },
        queuedComposerSend
      }
    })
    const send = makeCommand({
      commandId: '33333333-3333-4333-8333-333333333333',
      idempotencyKey: 'queued-composer-send-key',
      actor: ACTOR_A,
      name: 'composer.send',
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    const commandPromise = authority.command(contextFor(ACTOR_A, CLIENT_A), send)
    await Promise.resolve()
    expect(queueHeld).toBe(false)
    expect(executorCalls).toBe(0)
    releaseAck()
    const result = await commandPromise
    expect(result).toMatchObject({
      ok: true,
      value: { commandId: send.commandId, status: 'pending', phase: 'queued' }
    })
    expect(
      runtime.receiptStore.getByCommandId(send.commandId, {
        actorId: ACTOR_A.actorId,
        clientId: ACTOR_A.clientId,
        clientClass: ACTOR_A.clientClass
      })
    ).toMatchObject({ kind: 'found', receipt: { status: 'pending', phase: 'queued' } })

    await expect(authority.command(contextFor(ACTOR_A, CLIENT_A), send)).resolves.toMatchObject({
      ok: true,
      value: { commandId: send.commandId, status: 'pending', phase: 'queued' }
    })
    expect(queuedComposerSend).toHaveBeenCalledTimes(1)
    expect(runtime.receiptStore.size).toBe(1)
  })

  it('settles the original receipt when the snapshot donor throws before ACK', async () => {
    const authority = open({
      ports: {
        queuedComposerSend: () => ({ status: 'succeeded' as const, resultSummary: 'run_queued' }),
        snapshotDonor: () => {
          throw new Error('donor unavailable')
        }
      }
    })
    const send = makeCommand({
      commandId: '77777777-7777-4777-8777-777777777777',
      idempotencyKey: 'queued-donor-key',
      actor: ACTOR_A,
      name: 'composer.send',
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    await expect(authority.command(contextFor(ACTOR_A, CLIENT_A), send)).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    const found = runtime.receiptStore.getByCommandId(send.commandId, {
      actorId: ACTOR_A.actorId,
      clientId: ACTOR_A.clientId,
      clientClass: ACTOR_A.clientClass
    })
    expect(found).toMatchObject({ kind: 'found', receipt: { status: 'failed' } })
    expect(runtime.receiptStore.size).toBe(1)
  })

  it('marks the original receipt indeterminate when ACK throws after registration', async () => {
    const authority = open({
      ports: {
        queuedComposerSend: async () => {
          throw new Error('ack exploded')
        }
      }
    })
    const send = makeCommand({
      commandId: '88888888-8888-4888-8888-888888888888',
      idempotencyKey: 'queued-ack-throw-key',
      actor: ACTOR_A,
      name: 'composer.send',
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    await expect(authority.command(contextFor(ACTOR_A, CLIENT_A), send)).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    const found = runtime.receiptStore.getByCommandId(send.commandId, {
      actorId: ACTOR_A.actorId,
      clientId: ACTOR_A.clientId,
      clientClass: ACTOR_A.clientClass
    })
    expect(found).toMatchObject({
      kind: 'found',
      receipt: { status: 'indeterminate' }
    })
    authority.handleQueuedStartDispatchSettled(send.commandId, { status: 'succeeded' })
    await authority.drainQueuedStartPublication()
    const again = runtime.receiptStore.getByCommandId(send.commandId, {
      actorId: ACTOR_A.actorId,
      clientId: ACTOR_A.clientId,
      clientClass: ACTOR_A.clientClass
    })
    expect(again).toMatchObject({ kind: 'found', receipt: { status: 'indeterminate' } })
    expect(runtime.receiptStore.size).toBe(1)
  })

  it('ACK failure unregisters publication so a later start cannot succeed the receipt', async () => {
    const authority = open({
      ports: {
        queuedComposerSend: () => ({ status: 'failed' as const, errorCode: 'host_saturated' })
      }
    })
    const send = makeCommand({
      commandId: '99999999-9999-4999-8999-999999999999',
      idempotencyKey: 'queued-ack-fail-key',
      actor: ACTOR_A,
      name: 'composer.send',
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    const result = await authority.command(contextFor(ACTOR_A, CLIENT_A), send)
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'failed', errorCode: 'host_saturated' }
    })
    authority.handleQueuedStartDispatchSettled(send.commandId, { status: 'succeeded' })
    await authority.drainQueuedStartPublication()
    const found = runtime.receiptStore.getByCommandId(send.commandId, {
      actorId: ACTOR_A.actorId,
      clientId: ACTOR_A.clientId,
      clientClass: ACTOR_A.clientClass
    })
    expect(found).toMatchObject({
      kind: 'found',
      receipt: { status: 'failed', errorCode: 'host_saturated' }
    })
    expect(runtime.receiptStore.size).toBe(1)
  })

  it('dispatch failure terminalizes the original pending receipt and does not mint a second one', async () => {
    const authority = open({
      ports: {
        queuedComposerSend: () => ({ status: 'succeeded' as const, resultSummary: 'run_queued' })
      }
    })
    const send = makeCommand({
      commandId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'queued-fail-key',
      actor: ACTOR_A,
      name: 'composer.send',
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    const result = await authority.command(contextFor(ACTOR_A, CLIENT_A), send)
    expect(result).toMatchObject({ ok: true, value: { status: 'pending' } })
    expect(runtime.receiptStore.size).toBe(1)
    authority.handleQueuedStartDispatchSettled(send.commandId, {
      status: 'failed',
      errorCode: 'host_saturated'
    })
    const found = runtime.receiptStore.getByCommandId(send.commandId, {
      actorId: ACTOR_A.actorId,
      clientId: ACTOR_A.clientId,
      clientClass: ACTOR_A.clientClass
    })
    expect(found).toMatchObject({
      kind: 'found',
      receipt: { status: 'failed', errorCode: 'host_saturated' }
    })
    expect(runtime.receiptStore.size).toBe(1)
  })

  it('does not publish start effects until a held legacy projection-queue window releases', async () => {
    let releaseQueue!: () => void
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    let queueEntered = false
    let donorPhase = 0
    const send = makeCommand({
      commandId: '66666666-6666-4666-8666-666666666666',
      idempotencyKey: 'queued-queue-key',
      actor: ACTOR_A,
      name: 'composer.send',
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    const authority = open({
      ports: {
        runProjectionOperation: async (operation) => {
          queueEntered = true
          await queueGate
          return operation()
        },
        queuedComposerSend: () => ({ status: 'succeeded' as const, resultSummary: 'run_queued' }),
        snapshotDonor: () => {
          donorPhase += 1
          return donorFamilies({
            threads:
              donorPhase > 1
                ? [
                    {
                      id: 'thread-1',
                      messageCount: 1,
                      updatedAt: 2
                    } as AppStoreHostAuthoritySnapshotDonorFamilies['threads'][number]
                  ]
                : [
                    {
                      id: 'thread-1'
                    } as AppStoreHostAuthoritySnapshotDonorFamilies['threads'][number]
                  ],
            runs:
              donorPhase > 1
                ? [
                    {
                      runId: send.commandId,
                      threadId: 'thread-1',
                      providerId: 'codex',
                      providerOutcome: 'running'
                    } as AppStoreHostAuthoritySnapshotDonorFamilies['runs'][number]
                  ]
                : []
          })
        }
      }
    })
    await expect(authority.command(contextFor(ACTOR_A, CLIENT_A), send)).resolves.toMatchObject({
      ok: true,
      value: { status: 'pending', phase: 'queued' }
    })
    const fingerprint = fingerprintHostCommand(send).fingerprint
    const executionClaimCursor = { coverageEpoch: 'a'.repeat(64), sequence: 12 }
    authority.handleQueuedStartStarting({
      commandId: send.commandId,
      threadId: 'thread-1',
      fingerprint,
      phase: 'starting',
      executionClaimCursor,
      startedEvidence: false,
      terminalOutcome: null
    })
    let phased = runtime.receiptStore.getByCommandId(send.commandId, {
      actorId: ACTOR_A.actorId,
      clientId: ACTOR_A.clientId,
      clientClass: ACTOR_A.clientClass
    })
    expect(phased).toMatchObject({
      kind: 'found',
      receipt: { status: 'pending', phase: 'starting', executionClaimCursor }
    })
    authority.handleQueuedStartStarted({
      commandId: send.commandId,
      threadId: 'thread-1',
      fingerprint,
      phase: 'started',
      startedEvidence: true,
      terminalOutcome: null
    })
    phased = runtime.receiptStore.getByCommandId(send.commandId, {
      actorId: ACTOR_A.actorId,
      clientId: ACTOR_A.clientId,
      clientClass: ACTOR_A.clientClass
    })
    // beginRun/onStarted is still too early: user-prompt persistence is not proven.
    expect(phased).toMatchObject({
      kind: 'found',
      receipt: { status: 'pending', phase: 'starting' }
    })

    const positionBefore = runtime.getPosition()
    authority.handleQueuedStartDispatchSettled(send.commandId, { status: 'succeeded' })
    await Promise.resolve()
    expect(queueEntered).toBe(true)
    expect(runtime.getPosition()).toEqual(positionBefore)
    releaseQueue()
    await authority.drainQueuedStartPublication()
    const found = runtime.receiptStore.getByCommandId(send.commandId, {
      actorId: ACTOR_A.actorId,
      clientId: ACTOR_A.clientId,
      clientClass: ACTOR_A.clientClass
    })
    expect(found).toMatchObject({
      kind: 'found',
      receipt: { status: 'succeeded', phase: 'started', executionClaimCursor }
    })
    expect(runtime.getPosition().cursor).toBeGreaterThan(positionBefore.cursor)
  })

  it('does not publish a same-thread mission that appears during a blocked ACK', async () => {
    let releaseAck!: () => void
    const hungAck = new Promise<{ status: 'succeeded'; resultSummary: string }>((resolve) => {
      releaseAck = () => resolve({ status: 'succeeded', resultSummary: 'run_queued' })
    })
    let ackEntered = false
    let contaminate = false
    const send = makeCommand({
      commandId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'queued-ack-contaminate-key',
      actor: ACTOR_A,
      name: 'composer.send',
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    const authority = open({
      ports: {
        queuedComposerSend: () => {
          ackEntered = true
          return hungAck
        },
        snapshotDonor: () =>
          donorFamilies({
            threads: contaminate
              ? [
                  {
                    id: 'thread-1',
                    messageCount: 1,
                    updatedAt: 2
                  } as AppStoreHostAuthoritySnapshotDonorFamilies['threads'][number]
                ]
              : [
                  {
                    id: 'thread-1'
                  } as AppStoreHostAuthoritySnapshotDonorFamilies['threads'][number]
                ],
            runs: contaminate
              ? [
                  {
                    runId: send.commandId,
                    threadId: 'thread-1',
                    providerId: 'codex',
                    providerOutcome: 'running'
                  } as AppStoreHostAuthoritySnapshotDonorFamilies['runs'][number],
                  {
                    runId: 'other-run',
                    threadId: 'thread-1',
                    providerId: 'codex',
                    providerOutcome: 'running'
                  } as AppStoreHostAuthoritySnapshotDonorFamilies['runs'][number]
                ]
              : [],
            missions: contaminate
              ? [
                  {
                    missionId: 'concurrent-mission',
                    threadId: 'thread-1'
                  } as AppStoreHostAuthoritySnapshotDonorFamilies['missions'][number]
                ]
              : []
          })
      }
    })
    const commandPromise = authority.command(contextFor(ACTOR_A, CLIENT_A), send)
    await vi.waitFor(() => expect(ackEntered).toBe(true))
    contaminate = true
    releaseAck()
    await expect(commandPromise).resolves.toMatchObject({
      ok: true,
      value: { status: 'pending' }
    })
    const positionBefore = runtime.getPosition()
    authority.handleQueuedStartDispatchSettled(send.commandId, { status: 'succeeded' })
    await authority.drainQueuedStartPublication()
    const deltaResult = runtime.deltaStore.since(positionBefore)
    expect(deltaResult).toMatchObject({ kind: 'deltas' })
    expect(deltaResult).toMatchObject({
      kind: 'deltas',
      deltas: expect.arrayContaining([
        expect.objectContaining({ family: 'run', entityId: send.commandId, kind: 'upsert' })
      ])
    })
    expect(
      deltaResult.kind === 'deltas' &&
        deltaResult.deltas.some((delta) => delta.family === 'mission')
    ).toBe(false)
    expect(
      deltaResult.kind === 'deltas' &&
        deltaResult.deltas.some((delta) => delta.family === 'run' && delta.entityId === 'other-run')
    ).toBe(false)
    expect(deltaResult).toMatchObject({
      kind: 'deltas',
      deltas: expect.arrayContaining([
        expect.objectContaining({ family: 'thread', entityId: 'thread-1', kind: 'upsert' })
      ])
    })
  })

  // A-prime: the in-main Bridge route persists its run under its own appRunId,
  // never under the commandId. The settled dispatch binds that row as
  // evidence; without the binding the start is unproven and must fail closed.
  describe('bound run entity (in-main route)', () => {
    const BRIDGE_RUN_ID = 'app-run-bridge'

    function openWithForeignRunRow(
      send: HostCommand,
      options: { readonly runThreadId: string }
    ): { authority: ReturnType<typeof open>; start: () => Promise<void> } {
      let contaminate = false
      let ackEntered = false
      let releaseAck!: () => void
      const hungAck = new Promise<{ status: 'succeeded'; resultSummary: string }>((resolve) => {
        releaseAck = () => resolve({ status: 'succeeded', resultSummary: 'run_queued' })
      })
      const authority = open({
        ports: {
          queuedComposerSend: () => {
            ackEntered = true
            return hungAck
          },
          snapshotDonor: () =>
            donorFamilies({
              threads: [
                {
                  id: 'thread-1',
                  ...(contaminate ? { messageCount: 1, updatedAt: 2 } : {})
                } as AppStoreHostAuthoritySnapshotDonorFamilies['threads'][number]
              ],
              runs: contaminate
                ? [
                    {
                      runId: BRIDGE_RUN_ID,
                      threadId: options.runThreadId,
                      providerId: 'codex',
                      providerOutcome: 'running'
                    } as AppStoreHostAuthoritySnapshotDonorFamilies['runs'][number]
                  ]
                : []
            })
        }
      })
      return {
        authority,
        start: async () => {
          const commandPromise = authority.command(contextFor(ACTOR_A, CLIENT_A), send)
          await vi.waitFor(() => expect(ackEntered).toBe(true))
          contaminate = true
          releaseAck()
          await expect(commandPromise).resolves.toMatchObject({
            ok: true,
            value: { status: 'pending' }
          })
        }
      }
    }

    const receiptOf = (commandId: string) =>
      runtime.receiptStore.getByCommandId(commandId, {
        actorId: ACTOR_A.actorId,
        clientId: ACTOR_A.clientId,
        clientClass: ACTOR_A.clientClass
      })

    it('stays incoherent when the settlement binds no run entity', async () => {
      const send = makeCommand({
        commandId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
        idempotencyKey: 'queued-unbound-run-key',
        actor: ACTOR_A,
        name: 'composer.send',
        target: { threadId: 'thread-1' },
        arguments: { text: 'hello' }
      })
      const { authority, start } = openWithForeignRunRow(send, { runThreadId: 'thread-1' })
      await start()

      authority.handleQueuedStartDispatchSettled(send.commandId, { status: 'succeeded' })
      await authority.drainQueuedStartPublication()

      // The only run row carries a foreign id, so the commandId lookup finds
      // nothing and the start is not proven.
      expect(receiptOf(send.commandId)).toMatchObject({
        kind: 'found',
        receipt: { status: 'indeterminate', errorCode: 'observation_diff_incoherent' }
      })
    })

    it('succeeds and publishes the foreign run row when the settlement binds it', async () => {
      const send = makeCommand({
        commandId: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
        idempotencyKey: 'queued-bound-run-key',
        actor: ACTOR_A,
        name: 'composer.send',
        target: { threadId: 'thread-1' },
        arguments: { text: 'hello' }
      })
      const { authority, start } = openWithForeignRunRow(send, { runThreadId: 'thread-1' })
      await start()

      const positionBefore = runtime.getPosition()
      authority.handleQueuedStartDispatchSettled(
        send.commandId,
        { status: 'succeeded' },
        { runEntityId: BRIDGE_RUN_ID }
      )
      await authority.drainQueuedStartPublication()

      expect(receiptOf(send.commandId)).toMatchObject({
        kind: 'found',
        receipt: { status: 'succeeded' }
      })
      const deltaResult = runtime.deltaStore.since(positionBefore)
      expect(deltaResult).toMatchObject({
        kind: 'deltas',
        deltas: expect.arrayContaining([
          expect.objectContaining({ family: 'run', entityId: BRIDGE_RUN_ID, kind: 'upsert' }),
          expect.objectContaining({ family: 'thread', entityId: 'thread-1', kind: 'upsert' })
        ])
      })
      // Evidence, not identity: no row is published under the commandId.
      expect(
        deltaResult.kind === 'deltas' &&
          deltaResult.deltas.some((delta) => delta.entityId === send.commandId)
      ).toBe(false)
    })

    // End-to-end this is carried by the command scope, which strips the
    // foreign-thread run before the diff runs. The coordinator's own
    // fail-closed branch is pinned directly in HostQueuedStartPublication.test.
    it('cannot borrow another thread’s run row for a bound entity', async () => {
      const send = makeCommand({
        commandId: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3',
        idempotencyKey: 'queued-bound-foreign-thread-key',
        actor: ACTOR_A,
        name: 'composer.send',
        target: { threadId: 'thread-1' },
        arguments: { text: 'hello' }
      })
      const { authority, start } = openWithForeignRunRow(send, { runThreadId: 'thread-other' })
      await start()

      authority.handleQueuedStartDispatchSettled(
        send.commandId,
        { status: 'succeeded' },
        { runEntityId: BRIDGE_RUN_ID }
      )
      await authority.drainQueuedStartPublication()

      // Matching the id alone would let another thread's run stand as this
      // start's proof.
      expect(receiptOf(send.commandId)).toMatchObject({
        kind: 'found',
        receipt: { status: 'indeterminate', errorCode: 'observation_diff_incoherent' }
      })
    })

    it('ignores bound evidence on a failed settlement and terminalizes as before', async () => {
      const send = makeCommand({
        commandId: 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4',
        idempotencyKey: 'queued-bound-failed-key',
        actor: ACTOR_A,
        name: 'composer.send',
        target: { threadId: 'thread-1' },
        arguments: { text: 'hello' }
      })
      const { authority, start } = openWithForeignRunRow(send, { runThreadId: 'thread-1' })
      await start()

      authority.handleQueuedStartDispatchSettled(
        send.commandId,
        { status: 'failed', errorCode: 'provider_rejected' },
        { runEntityId: BRIDGE_RUN_ID }
      )
      await authority.drainQueuedStartPublication()

      expect(receiptOf(send.commandId)).toMatchObject({
        kind: 'found',
        receipt: { status: 'failed', errorCode: 'provider_rejected' }
      })
    })
  })

  describe('abandoning proof for a queued start', () => {
    function receiptOfCommand(commandId: string): unknown {
      return runtime.receiptStore.getByCommandId(commandId, {
        actorId: ACTOR_A.actorId,
        clientId: ACTOR_A.clientId,
        clientClass: ACTOR_A.clientClass
      })
    }

    async function openPendingQueuedSend(commandId: string): Promise<ReturnType<typeof open>> {
      const authority = open({
        ports: {
          queuedComposerSend: () => ({ status: 'succeeded' as const, resultSummary: 'run_queued' }),
          commandExecutor: () => {
            throw new Error('legacy observed executor must not run for queued composer.send')
          }
        }
      })
      const send = makeCommand({
        commandId,
        idempotencyKey: `abort-${commandId}`,
        actor: ACTOR_A,
        name: 'composer.send',
        target: { threadId: 'thread-1' },
        arguments: { text: 'hello' }
      })
      await authority.command(contextFor(ACTOR_A, CLIENT_A), send)
      expect(receiptOfCommand(commandId)).toMatchObject({
        kind: 'found',
        receipt: { status: 'pending' }
      })
      return authority
    }

    it('promotes a pending queued receipt to indeterminate without publishing or completing', async () => {
      const commandId = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a'
      const authority = await openPendingQueuedSend(commandId)
      const positionBefore = runtime.getPosition()

      authority.abortQueuedStart(commandId)
      await authority.drainQueuedStartPublication()

      // Never succeeded (nothing was proven) and never failed (the prompt may
      // well have been delivered) — the receipt abandons proof instead.
      expect(receiptOfCommand(commandId)).toMatchObject({
        kind: 'found',
        receipt: { status: 'indeterminate', errorCode: 'deferred_execution_may_have_begun' }
      })
      // Abandoning proof publishes nothing: a start we cannot verify must not
      // leave a run/round row behind, so the journal must not have advanced.
      expect(runtime.getPosition()).toEqual(positionBefore)
      expect(runtime.deltaStore.since(positionBefore)).toMatchObject({ kind: 'deltas', deltas: [] })
    })

    it('characterisation: writes nothing for an unknown or already-settled commandId', async () => {
      // NOT new behaviour. The guarantee comes from abort()'s pending gate and
      // the receipt store's terminal refusal, neither of which this slice
      // changes; the test exists so a future change to either is caught here.
      const commandId = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b'
      const authority = await openPendingQueuedSend(commandId)

      authority.abortQueuedStart('6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c')
      await authority.drainQueuedStartPublication()
      expect(receiptOfCommand(commandId)).toMatchObject({
        kind: 'found',
        receipt: { status: 'pending' }
      })
      expect(runtime.receiptStore.size).toBe(1)

      // Now terminalize it, then abandon again: the terminal record stands.
      authority.handleQueuedStartDispatchSettled(commandId, {
        status: 'failed',
        errorCode: 'provider_rejected'
      })
      await authority.drainQueuedStartPublication()
      const settled = receiptOfCommand(commandId)
      authority.abortQueuedStart(commandId)
      await authority.drainQueuedStartPublication()
      expect(receiptOfCommand(commandId)).toStrictEqual(settled)
      expect(receiptOfCommand(commandId)).toMatchObject({
        kind: 'found',
        receipt: { status: 'failed', errorCode: 'provider_rejected' }
      })
    })

    it('is a silent no-op when no publication is composed (flag OFF)', () => {
      const authority = open()
      expect(() => authority.abortQueuedStart('7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d')).not.toThrow()
      expect(runtime.receiptStore.size).toBe(0)
    })
  })

  it('without queuedComposerSend, composer.send still uses the observed executor (flag-off equivalent)', async () => {
    const authority = open()
    const send = makeCommand({
      commandId: '44444444-4444-4444-8444-444444444444',
      idempotencyKey: 'legacy-composer-send-key',
      actor: ACTOR_A,
      name: 'composer.send',
      target: { threadId: 'thread-1' },
      arguments: { text: 'hello' }
    })
    const result = await authority.command(contextFor(ACTOR_A, CLIENT_A), send)
    expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
    expect(result).not.toHaveProperty('value.phase')
    expect(executorCalls).toBe(1)
  })
})
