import { existsSync, readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCapability,
  type HostCommand,
  type HostHealthProjection
} from '../../shared/hostProtocol'
import {
  TASKWRAITH_HOST_DISCOVERY_FILE,
  TASKWRAITH_HOST_SOCKET_FILE,
  TASKWRAITH_HOST_TOKEN_FILE
} from '../../shared/taskWraithHostPaths.node'
import type {
  AppStoreHostAuthorityExecutor,
  AppStoreHostAuthoritySnapshotDonorFamilies
} from './AppStoreHostAuthority'
import type { HostAuthorityCallContext } from './HostAuthority'
import { HostCommandMutationPipeline } from './HostCommandMutationPipeline'
import { HostDeferredAllowPipeline } from './HostDeferredAllowPipeline'
import { HostDeferredCommandBridge } from './HostDeferredCommandBridge'
import { HostDeferredCommandEnvelopeResolver } from './HostDeferredCommandEnvelopeResolver'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import { HostMutationCompletionCoordinator } from './HostMutationCompletionCoordinator'
import { HostObservedMutationExecutor } from './HostObservedMutationExecutor'
import type { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import {
  createHostMainComposition,
  createUnwiredDeferredResolutionPorts,
  HOST_DEFERRED_RESOLUTION_UNWIRED_CODE,
  HOST_RUNTIME_DATA_DIR_NAME,
  hostRuntimeDataDir,
  type HostMainComposition,
  type HostMainCompositionInput
} from './HostMainComposition'

const ACTOR_A: HostActorIdentity = {
  actorId: 'actor-a',
  clientId: 'client-a',
  clientClass: 'desktop'
}

const CLIENT_A: HostAuthenticatedClientIdentity = {
  clientId: 'client-a',
  clientClass: 'desktop',
  clientVersion: '1.9.2'
}

const NOW = '2026-08-04T09:00:00.000Z'

const DEFERRED_COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const DEFERRED_IDEMPOTENCY_KEY = 'desktop:client-a:22222222-2222-4222-8222-222222222222'
const SESSION_ID = '44444444-4444-4444-8444-444444444444'

/** A distinctive body value — a body-free projection must never echo it. */
const SECRET_TARGET_ID = 'thread-body-secret-do-not-project'

const CAPABILITIES: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'commands',
  'receipts',
  'health',
  'recovery'
]

function contextFor(actor: HostActorIdentity): HostAuthorityCallContext {
  return {
    actor,
    client: {
      clientId: actor.clientId,
      clientClass: actor.clientClass,
      clientVersion: CLIENT_A.clientVersion
    }
  }
}

function makeCommand(
  overrides: Partial<HostCommand> & Pick<HostCommand, 'commandId' | 'idempotencyKey' | 'actor'>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    name: 'thread.select',
    target: { threadId: SECRET_TARGET_ID },
    arguments: {},
    issuedAt: NOW,
    ...overrides
  }
}

function donorFamilies(): AppStoreHostAuthoritySnapshotDonorFamilies {
  return {
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
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
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: []
  }
}

const HEALTH: HostHealthProjection = {
  hostStatus: 'ok',
  connectionPhase: 'live',
  supervised: true,
  freshness: 'live'
}

// S4c: mock pipeline for tests
const mockPipelineExecute = vi.fn(async () => ({
  kind: 'completed' as const,
  status: 'succeeded' as const,
  position: { generation: 0, cursor: 0 }
}))

const mockPipeline: HostDeferredAllowPipeline = {
  execute: mockPipelineExecute
} as unknown as HostDeferredAllowPipeline

describe('HostMainComposition', () => {
  let userDataPath: string
  let executor: ReturnType<typeof vi.fn>
  let composition: HostMainComposition

  const open = (overrides: Partial<HostMainCompositionInput> = {}): HostMainComposition =>
    createHostMainComposition({
      userDataPath,
      commandExecutor: executor as unknown as AppStoreHostAuthorityExecutor,
      snapshotDonor: () => donorFamilies(),
      authorityEvaluator: () => ({ decision: 'allowed' as const }),
      healthProvider: () => HEALTH,
      host: { hostId: 'host-1', hostVersion: '1.9.2' },
      hostCapabilityOffer: CAPABILITIES,
      pipeline: mockPipeline,
      now: () => NOW,
      ...overrides
    })

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'host-main-composition-'))
    executor = vi.fn(async () => ({ status: 'succeeded' as const, resultSummary: 'ok' }))
    vi.resetAllMocks()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // Deterministic host data directory
  // -----------------------------------------------------------------------

  describe('hostDataDir', () => {
    it('is a deterministic documented subdirectory of the injected userData path', () => {
      expect(HOST_RUNTIME_DATA_DIR_NAME).toBe('host-runtime')
      expect(hostRuntimeDataDir('/tmp/user-data')).toBe(join('/tmp/user-data', 'host-runtime'))

      composition = open()
      expect(composition.hostDataDir).toBe(join(userDataPath, HOST_RUNTIME_DATA_DIR_NAME))
    })

    it('does not collide with existing userData entries or the v2 control artifacts', () => {
      // Real userData entry names observed in src/main at the time of writing.
      const existingUserDataEntries = [
        'agent-stats',
        'approval-ledger.json',
        'audit-runs.json',
        'bridge-logs',
        'canvas',
        'chats',
        'chat-list-index.json',
        'checkpoints',
        'evidence-packs.json',
        'gemini-oauth-profiles',
        'handoff-cards.json',
        'login',
        'mistral',
        'plugins',
        'projects.json',
        'run-artifacts',
        'run-events',
        'run-queue.json',
        'run-recovery.json',
        'runtime-profiles.json',
        'scheduled-tasks.json',
        'settings.json',
        'subthread-mailboxes.json'
      ]
      expect(existingUserDataEntries).not.toContain(HOST_RUNTIME_DATA_DIR_NAME)

      // Wave 3.1 v2 control artifacts stay FILES at the userData root.
      expect([
        TASKWRAITH_HOST_DISCOVERY_FILE,
        TASKWRAITH_HOST_TOKEN_FILE,
        TASKWRAITH_HOST_SOCKET_FILE
      ]).not.toContain(HOST_RUNTIME_DATA_DIR_NAME)
    })

    it('confines every durable Host write to that subdirectory', async () => {
      composition = open()
      const result = await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({ commandId: 'cmd-confine', idempotencyKey: 'key-confine', actor: ACTOR_A })
      )
      expect(result.ok).toBe(true)
      composition.getRecoverySummary()
      await composition.shutdown()

      expect(existsSync(composition.hostDataDir)).toBe(true)
      expect(readdirSync(userDataPath)).toEqual([HOST_RUNTIME_DATA_DIR_NAME])
      expect(readdirSync(composition.hostDataDir).length).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // Fail-closed construction
  // -----------------------------------------------------------------------

  describe('fail-closed construction', () => {
    it('rejects a missing userDataPath', () => {
      expect(() => open({ userDataPath: '' })).toThrow(/userDataPath/)
    })

    it('rejects a missing executor port', () => {
      expect(() =>
        open({ commandExecutor: undefined as unknown as AppStoreHostAuthorityExecutor })
      ).toThrow(/commandExecutor/)
    })

    it('rejects missing donor / evaluator / health ports', () => {
      expect(() => open({ snapshotDonor: undefined as never })).toThrow(/snapshotDonor/)
      expect(() => open({ authorityEvaluator: undefined as never })).toThrow(/authorityEvaluator/)
      expect(() => open({ healthProvider: undefined as never })).toThrow(/healthProvider/)
    })

    it('rejects an incomplete host identity or capability offer', () => {
      expect(() => open({ host: { hostId: '', hostVersion: '1.9.2' } })).toThrow(/host identity/)
      expect(() => open({ host: { hostId: 'host-1', hostVersion: '' } })).toThrow(/host identity/)
      expect(() => open({ hostCapabilityOffer: undefined as never })).toThrow(/hostCapabilityOffer/)
    })

    it('rejects a missing pipeline (S4c)', () => {
      expect(() => open({ pipeline: undefined as never })).toThrow(/pipeline/)
    })

    it('rejects a pipeline without execute (S4c)', () => {
      expect(() => open({ pipeline: {} as never })).toThrow(/pipeline\.execute/)
    })
  })

  // -----------------------------------------------------------------------
  // Executor injection (the W3-P3 seam)
  // -----------------------------------------------------------------------

  describe('executor injection', () => {
    it('routes an allowed command through the injected executor exactly once', async () => {
      composition = open()
      const result = await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({ commandId: 'cmd-exec-1', idempotencyKey: 'key-exec-1', actor: ACTOR_A })
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('succeeded')
      expect(executor).toHaveBeenCalledTimes(1)
      const [command] = executor.mock.calls[0] as [HostCommand]
      expect(command.commandId).toBe('cmd-exec-1')
      expect(command.name).toBe('thread.select')
    })

    it('passes the terminal executor status through instead of rewriting it', async () => {
      executor = vi.fn(async () => ({
        status: 'cancelled' as const,
        errorCode: 'provider_cancelled'
      }))
      composition = open()
      const result = await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({ commandId: 'cmd-exec-2', idempotencyKey: 'key-exec-2', actor: ACTOR_A })
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('cancelled')
    })

    it('never constructs an executor of its own when one is injected', async () => {
      const injected = vi.fn(async () => ({ status: 'failed' as const, errorCode: 'nope' }))
      composition = open({
        commandExecutor: injected as unknown as AppStoreHostAuthorityExecutor
      })
      await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({ commandId: 'cmd-exec-3', idempotencyKey: 'key-exec-3', actor: ACTOR_A })
      )
      expect(injected).toHaveBeenCalledTimes(1)
      expect(executor).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Deferred ask wiring (envelope store + composition-owned bridge)
  // -----------------------------------------------------------------------

  describe('deferred ask wiring', () => {
    const deferredComposition = (): HostMainComposition =>
      open({ authorityEvaluator: () => ({ decision: 'deferred', challengeKind: 'approval' }) })

    it('persists a deferred ask into both durable halves without executing', async () => {
      composition = deferredComposition()
      const result = await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({
          commandId: DEFERRED_COMMAND_ID,
          idempotencyKey: DEFERRED_IDEMPOTENCY_KEY,
          actor: ACTOR_A
        })
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('pending')
      expect(executor).not.toHaveBeenCalled()

      const summary = composition.getRecoverySummary()
      expect(summary.envelopes.availability).toBe('available')
      if (summary.envelopes.availability !== 'available') return
      expect(summary.envelopes.size).toBe(1)
      // Bridge half is supplied by composition, so bootstrap can count it.
      expect(summary.deferred.availability).toBe('available')
      expect(summary.deferred.size).toBe(1)
    })

    it('keeps the recovery summary body-free', async () => {
      composition = deferredComposition()
      await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({
          commandId: DEFERRED_COMMAND_ID,
          idempotencyKey: DEFERRED_IDEMPOTENCY_KEY,
          actor: ACTOR_A
        })
      )

      const serialized = JSON.stringify(composition.getRecoverySummary())
      expect(serialized).not.toContain(SECRET_TARGET_ID)
      expect(serialized).not.toContain('thread.select')
    })

    it('leaves the deferred summary unavailable-free when nothing is deferred', () => {
      composition = open()
      const summary = composition.getRecoverySummary()
      expect(summary.deferred.availability).toBe('available')
      expect(summary.deferred.size).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // S4c — GAP-A donor wrap + required adapter wiring
  // -----------------------------------------------------------------------

  describe('S4c donor wrap and required deferred resolution', () => {
    it('publishes awaiting approval-kind challenges with approvalId = challengeId', async () => {
      composition = open({
        authorityEvaluator: () => ({ decision: 'deferred', challengeKind: 'approval' })
      })
      const result = await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({
          commandId: DEFERRED_COMMAND_ID,
          idempotencyKey: DEFERRED_IDEMPOTENCY_KEY,
          actor: ACTOR_A
        })
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('pending')

      const snap = await composition.authority.snapshot(contextFor(ACTOR_A))
      expect(snap.ok).toBe(true)
      if (!snap.ok) return
      expect(snap.value.approvals).toHaveLength(1)
      const published = snap.value.approvals[0]
      expect(published.status).toBe('pending')
      // PIN S4-V / GAP-A: actionKind ← commandName, not challengeKind
      expect(published.actionKind).toBe('thread.select')
      // WAVE 4.2c SOURCE PIN: the published card must name the EXACT command it
      // governs. The client-side RED-proof lives in the TUI, but it cannot catch
      // a strip HERE — a fixture would still supply commandId downstream. This
      // is the only assertion that fails if the donor wrap stops publishing it.
      expect(published.commandId).toBe(DEFERRED_COMMAND_ID)
      expect(published.summary).toContain('thread.select')
      expect(published.approvalId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
      // PIN S4-Q: questions family stays empty for approval-kind deferrals
      expect(snap.value.questions).toEqual([])
    })

    it('excludes question-kind awaiting rows from approvals publish (PIN S4-Q)', async () => {
      composition = open({
        authorityEvaluator: () => ({ decision: 'deferred', challengeKind: 'question' })
      })
      const result = await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({
          commandId: DEFERRED_COMMAND_ID,
          idempotencyKey: DEFERRED_IDEMPOTENCY_KEY,
          actor: ACTOR_A
        })
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('pending')

      const snap = await composition.authority.snapshot(contextFor(ACTOR_A))
      expect(snap.ok).toBe(true)
      if (!snap.ok) return
      expect(snap.value.approvals).toEqual([])
      // Slice-1: question-kind rows are NOT published as question cards either
      expect(snap.value.questions).toEqual([])
    })

    it('does not duplicate an approval already present under the challengeId', async () => {
      composition = open({
        authorityEvaluator: () => ({ decision: 'deferred', challengeKind: 'approval' }),
        snapshotDonor: () => ({
          ...donorFamilies(),
          approvals: [
            {
              approvalId: '55555555-5555-4555-8555-555555555555',
              commandId: '55555555-5555-4555-8555-555555555556',
              actionKind: 'pre-existing',
              status: 'pending',
              createdAt: Date.parse(NOW),
              summary: 'pre-existing card'
            }
          ]
        })
      })

      const result = await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({
          commandId: DEFERRED_COMMAND_ID,
          idempotencyKey: DEFERRED_IDEMPOTENCY_KEY,
          actor: ACTOR_A
        })
      )
      expect(result.ok).toBe(true)

      const snap = await composition.authority.snapshot(contextFor(ACTOR_A))
      expect(snap.ok).toBe(true)
      if (!snap.ok) return
      // Pre-existing donor card retained + one Bridge-minted challenge card
      expect(snap.value.approvals).toHaveLength(2)
      expect(
        snap.value.approvals.filter((a) => a.approvalId === '55555555-5555-4555-8555-555555555555')
      ).toHaveLength(1)
      expect(
        snap.value.approvals.find((a) => a.approvalId === '55555555-5555-4555-8555-555555555555')
          ?.actionKind
      ).toBe('pre-existing')
      const ids = snap.value.approvals.map((a) => a.approvalId)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('wires S4b hooks so correlated approval.decide hits pipeline once and zero H', async () => {
      composition = open({
        authorityEvaluator: (cmd) =>
          cmd.name === 'approval.decide'
            ? { decision: 'allowed' }
            : { decision: 'deferred', challengeKind: 'approval' }
      })
      const deferred = await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({
          commandId: DEFERRED_COMMAND_ID,
          idempotencyKey: DEFERRED_IDEMPOTENCY_KEY,
          actor: ACTOR_A
        })
      )
      expect(deferred.ok).toBe(true)
      if (!deferred.ok) return

      const snap = await composition.authority.snapshot(contextFor(ACTOR_A))
      expect(snap.ok).toBe(true)
      if (!snap.ok) return
      const card = snap.value.approvals[0]
      expect(card).toBeDefined()

      executor.mockClear()
      mockPipelineExecute.mockClear()

      const decide = await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({
          commandId: '66666666-6666-4666-8666-666666666666',
          idempotencyKey: 'desktop:client-a:77777777-7777-4777-8777-777777777777',
          actor: ACTOR_A,
          name: 'approval.decide',
          target: { approvalId: card.approvalId },
          arguments: { decision: 'accept' }
        })
      )
      expect(decide.ok).toBe(true)
      // E-first owns the path — live Bridge H executor must not run
      expect(executor).not.toHaveBeenCalled()
      // Adapter → pipeline exactly once on allow
      expect(mockPipelineExecute).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  // Unwired deferred resolution — fail closed, never fake success
  // -----------------------------------------------------------------------

  describe('unwired deferred resolution ports', () => {
    it('refuses every resolve-side port', () => {
      const ports = createUnwiredDeferredResolutionPorts()
      expect(() => ports.executeCommand({} as never)).toThrow(HOST_DEFERRED_RESOLUTION_UNWIRED_CODE)
      expect(() => ports.publishEffects({} as never)).toThrow(HOST_DEFERRED_RESOLUTION_UNWIRED_CODE)
      expect(() => ports.completeReceipt({} as never)).toThrow(
        HOST_DEFERRED_RESOLUTION_UNWIRED_CODE
      )
    })

    it('terminalizes an allow decision as failed rather than succeeded', async () => {
      const bridge = new HostDeferredCommandBridge({
        dataDir: join(userDataPath, HOST_RUNTIME_DATA_DIR_NAME),
        ports: createUnwiredDeferredResolutionPorts()
      })
      const actor = { clientId: 'client-a', actorId: 'actor-a', clientClass: 'desktop' as const }
      const registered = bridge.register({
        commandId: DEFERRED_COMMAND_ID,
        idempotencyKey: DEFERRED_IDEMPOTENCY_KEY,
        commandFingerprint: 'a'.repeat(64),
        commandName: 'thread.select',
        actor,
        challengeId: '33333333-3333-4333-8333-333333333333',
        challengeKind: 'approval'
      })
      expect(registered.kind).toBe('created')

      const resolved = await bridge.resolve({
        challengeId: '33333333-3333-4333-8333-333333333333',
        actor,
        decision: 'allow'
      })

      expect(resolved.kind).toBe('failed')
      if (resolved.kind !== 'failed') return
      expect(resolved.code).toBe('executor_failed')
      expect(resolved.record?.state).toBe('failed')
      expect(resolved.record?.state).not.toBe('succeeded')
    })
  })

  // -----------------------------------------------------------------------
  // Position + session binding
  // -----------------------------------------------------------------------

  describe('position and session', () => {
    it('reports position from the sole journal', async () => {
      composition = open()
      const before = composition.getPosition()
      expect(typeof before.generation).toBe('number')
      expect(typeof before.cursor).toBe('number')

      await composition.authority.command(
        contextFor(ACTOR_A),
        makeCommand({ commandId: 'cmd-pos-1', idempotencyKey: 'key-pos-1', actor: ACTOR_A })
      )
      const after = composition.getPosition()
      expect(after.generation).toBe(before.generation)
      expect(after.cursor).toBeGreaterThanOrEqual(before.cursor)
      expect(after).toEqual(composition.getRecoverySummary().position)
    })

    it('binds an authenticated client through the composed session', () => {
      composition = open({ sessionIdFactory: () => SESSION_ID })
      const bound = composition.session.bind({
        verifiedContext: {
          clientClass: CLIENT_A.clientClass,
          clientId: CLIENT_A.clientId,
          actorId: CLIENT_A.clientId
        },
        authenticatedClient: CLIENT_A,
        clientCapabilityRequest: ['snapshot', 'commands']
      })

      expect(bound.ok ? 'ok' : bound.error).toBe('ok')
      if (!bound.ok) return
      expect(bound.value.sessionId).toBe(SESSION_ID)
      expect(bound.value.boundGeneration).toBe(composition.getPosition().generation)
      expect(bound.value.boundCursor).toBe(composition.getPosition().cursor)
    })
  })

  // -----------------------------------------------------------------------
  // Shutdown / flush
  // -----------------------------------------------------------------------

  describe('shutdown', () => {
    it('flushes durable state once however often it is called', async () => {
      const onShutdown = vi.fn()
      composition = open({ onShutdown })

      await composition.shutdown()
      await composition.shutdown()
      await composition.shutdown()

      expect(onShutdown).toHaveBeenCalledTimes(1)
    })

    it('shares one idempotent flush with the authoritative host shutdown', async () => {
      const onShutdown = vi.fn()
      composition = open({ onShutdown })

      const stopped = await composition.authority.shutdown(contextFor(ACTOR_A))
      expect(stopped.ok).toBe(true)
      await composition.shutdown()

      expect(onShutdown).toHaveBeenCalledTimes(1)
    })

    it('does not open or close any listener', async () => {
      composition = open()
      await composition.shutdown()
      // Wave 3.1 control artifacts belong to the supervisor slice, not here.
      expect(existsSync(join(userDataPath, TASKWRAITH_HOST_DISCOVERY_FILE))).toBe(false)
      expect(existsSync(join(userDataPath, TASKWRAITH_HOST_TOKEN_FILE))).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Wave 3.6a — pipelineFactory seam
  // -----------------------------------------------------------------------

  describe('pipelineFactory seam', () => {
    it('rejects supplying both a pipeline and a pipelineFactory', () => {
      expect(() => open({ pipelineFactory: () => mockPipeline })).toThrow(/not both/)
    })

    it('keeps the S4c rejection verbatim when neither is supplied', () => {
      expect(() => open({ pipeline: undefined })).toThrow(
        'HostMainComposition requires an injected pipeline'
      )
    })

    it('validates a factory result with the same predicate a direct pipeline faces', () => {
      const empty = {} as unknown as HostDeferredAllowPipeline
      // Identical message from both routes => literally one predicate, not two
      // parallel ones that could drift apart later.
      expect(() => open({ pipeline: empty })).toThrow(
        'HostMainComposition requires an injected pipeline.execute'
      )
      expect(() => open({ pipeline: undefined, pipelineFactory: () => empty })).toThrow(
        'HostMainComposition requires an injected pipeline.execute'
      )
    })

    it('invokes the factory exactly once, after bootstrap, with the real runtime', () => {
      const seen: HostRuntimeBootstrap[] = []
      const factory = vi.fn((runtime: HostRuntimeBootstrap) => {
        seen.push(runtime)
        return mockPipeline
      })

      composition = open({ pipeline: undefined, pipelineFactory: factory })

      expect(factory).toHaveBeenCalledTimes(1)
      const runtime = seen[0]!
      // A constructed bootstrap, not a placeholder: all three stores exist...
      expect(runtime.deltaStore).toBeTruthy()
      expect(runtime.receiptStore).toBeTruthy()
      expect(runtime.envelopeStore).toBeTruthy()
      // ...and it is the SAME journal the composition itself reports from,
      // which is what proves no second bootstrap was created.
      expect(runtime.getPosition()).toEqual(composition.getPosition())
    })

    it('rejects the both-supplied wiring mistake WITHOUT invoking the factory', () => {
      // K3Review asked for "factory not invoked when a direct pipeline is set".
      // That state is unreachable — XOR rejects both-supplied — so the only
      // reachable form of the question is whether the rejection happens BEFORE
      // the factory runs. It must: a mis-wired root should never get a
      // half-built pipeline (or its side effects) out of a call that throws.
      const factory = vi.fn(() => mockPipeline)
      expect(() => open({ pipelineFactory: factory })).toThrow(/not both/)
      expect(factory).not.toHaveBeenCalled()
    })

    it('composes the real resolver/mutation/coordinator chain over the real stores', async () => {
      let built: HostDeferredAllowPipeline | null = null

      const realChain = (runtime: HostRuntimeBootstrap): HostDeferredAllowPipeline => {
        const resolver = new HostDeferredCommandEnvelopeResolver({
          envelopeStore: runtime.envelopeStore,
          receiptStore: runtime.receiptStore,
          // The AllowPipeline consumes only verifyCommand (zero-H). If this ever
          // runs, a second execution route has been opened by mistake.
          executor: {
            execute: async () => {
              throw new Error('resolver executor must never run under the AllowPipeline')
            }
          } as unknown as ConstructorParameters<
            typeof HostDeferredCommandEnvelopeResolver
          >[0]['executor']
        })
        const publisher = new HostDomainDeltaPublisher({ store: runtime.deltaStore })
        const coordinator = new HostMutationCompletionCoordinator({
          publishEffects: (effects) => publisher.publish(effects),
          getPosition: () => runtime.getPosition(),
          completeReceipt: (i) => runtime.receiptStore.complete(i),
          markIndeterminate: (i) => runtime.receiptStore.markIndeterminate(i)
        })
        const mutation = new HostCommandMutationPipeline({
          observe: async (command) =>
            new HostObservedMutationExecutor({
              captureSnapshot: async () => {
                throw new Error('capture is not reached on the unknown-envelope path')
              },
              executeCommand: async () => ({ status: 'succeeded' as const })
            }).execute(command),
          complete: (i) => coordinator.complete(i)
        })
        built = new HostDeferredAllowPipeline({
          verifyCommand: (i) => resolver.verifyCommand(i),
          pipeline: mutation
        })
        return built
      }

      composition = open({ pipeline: undefined, pipelineFactory: realChain })
      expect(built).not.toBeNull()

      // Drive the REAL chain. This deferred id has no envelope, so the real
      // resolver reads the real envelope store and refuses — proving the chain
      // is bound to live stores rather than mocks, with zero domain execution.
      const outcome = await built!.execute({
        deferredId: '33333333-3333-4333-8333-333333333333',
        commandId: DEFERRED_COMMAND_ID,
        idempotencyKey: DEFERRED_IDEMPOTENCY_KEY,
        commandFingerprint: 'a'.repeat(64),
        commandName: 'thread.select',
        actor: ACTOR_A,
        challengeId: '55555555-5555-4555-8555-555555555555',
        challengeKind: 'approval'
      })

      expect(outcome.kind).not.toBe('completed')
      expect(executor).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Import isolation (W3-P3 seam)
  // -----------------------------------------------------------------------

  describe('import isolation', () => {
    it('imports no electron, AppStore singleton, provider, or listener module', () => {
      const source = readFileSync(join(__dirname, 'HostMainComposition.ts'), 'utf8')
      const importLines = source
        .split('\n')
        .filter((line) => /^\s*(import|export .*from|const .*= require\()/.test(line))
        .join('\n')

      expect(importLines).not.toMatch(/['"]electron['"]/)
      // The AppStore module itself lives outside src/main/host — the Authority
      // class merely carries the historic name and reads no AppStore.
      expect(importLines).not.toMatch(/from ['"]\.\.\/AppStore/)
      expect(importLines).not.toMatch(/from ['"]\.\.\/BridgeActionExecutor/)
      expect(importLines).not.toMatch(/from ['"]\.\.\/providers/)
      expect(importLines).not.toMatch(/workLocks/)
      expect(importLines).not.toMatch(/workProvenance/)
      expect(importLines).not.toMatch(/HostLocalServer/)
      expect(importLines).not.toMatch(/from ['"].*\/index['"]/)
    })

    it('constructs no HostLocalServer — the supervisor owns listener lifecycle', () => {
      const source = readFileSync(join(__dirname, 'HostMainComposition.ts'), 'utf8')
      expect(source).not.toMatch(/new HostLocalServer/)
    })
  })

  // -----------------------------------------------------------------------
  // Wave 5 — AC9 capture seam (composition-level pin)
  // -----------------------------------------------------------------------

  describe('exportTwMission', () => {
    it('exports a privacy-safe bundle from the live snapshot', async () => {
      composition = open()
      const result = await composition.exportTwMission(contextFor(ACTOR_A))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.bundle.manifest.hostId).toBe('host-1')
      const position = composition.getPosition()
      expect(result.bundle.manifest.cursorRange).toEqual({
        generation: position.generation,
        fromCursor: 0,
        toCursor: position.cursor
      })
      expect(result.bundle.manifest.redaction.transcriptsOmitted).toBe(true)
      expect(result.bundle.manifest.redaction.artifactBodiesOmitted).toBe(true)
    })

    it('accepts exportedAt and redactionNotes options', async () => {
      composition = open()
      const result = await composition.exportTwMission(contextFor(ACTOR_A), {
        exportedAt: NOW,
        redactionNotes: ['twmission-export-note']
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.bundle.manifest.exportedAt).toBe(NOW)
      expect(result.bundle.manifest.redaction.notes).toEqual(['twmission-export-note'])
    })

    it('does not advance the sole journal position', async () => {
      composition = open()
      const before = composition.getPosition()
      const result = await composition.exportTwMission(contextFor(ACTOR_A))

      expect(result.ok).toBe(true)
      expect(composition.getPosition()).toEqual(before)
    })

    it('is absent from the HostAuthority surface (composition-only seam)', () => {
      composition = open()
      expect('exportTwMission' in composition.authority).toBe(false)
    })
  })
})
