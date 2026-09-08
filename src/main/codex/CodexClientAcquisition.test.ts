import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerClient } from '../CodexAppServerClient'
import { shouldRestartCodexAppServerForMcpConfig } from '../CodexRunRouting'
import { buildUserMcpLaunchServers } from '../UserMcpServers'
import * as profileFence from '../mcp/McpSessionProfileFence'
import type { RuntimeProfile } from '../store/types'
import {
  createCodexClientAcquisition,
  type CodexClientAcquisitionDependencies,
  type CodexClientAcquisitionPayload,
  type CodexClientLifecycleLease,
  type CodexProviderClientCohortResource
} from './CodexClientAcquisition'
import { CodexClientLifecycleQueue } from './CodexClientLifecycleQueue'
import { CodexClientRunCohortRegistry } from './CodexClientRunCohort'

class AcquireAbortedError extends Error {}

class FakeClient {
  constructor(...args: ConstructorParameters<typeof CodexAppServerClient>) {
    this.constructorArgs = args
  }

  readonly constructorArgs: ConstructorParameters<typeof CodexAppServerClient>
  setRuntimeProfile = vi.fn()
  setMcpConfig = vi.fn()
  setCredentialLeaseConsent = vi.fn()
  hasStaleMcpConfig = vi.fn(() => false)
  hasStaleCredentialLeaseConsent = vi.fn(() => false)
  dispose = vi.fn()
  setWorkspaceLockOwnerId = vi.fn()
}

function fixture(cohortFairness?: boolean) {
  let client: FakeClient | null = null
  let lease: CodexClientLifecycleLease | null = null
  const settings = {
    userMcpServers: [] as Parameters<typeof buildUserMcpLaunchServers>[0],
    geminiMcpBridgeEnabled: true,
    codexReuseExistingLogin: false
  }
  let runtimeProfiles: RuntimeProfile[] = []
  const activeSessions: { state: unknown }[] = []
  const deps: CodexClientAcquisitionDependencies<FakeClient> = {
    ...profileFence,
    flags: { cohortFairness },
    get codexClient() {
      return client
    },
    set codexClient(value) {
      client = value
    },
    get activeCodexClientLifecycleLease() {
      return lease
    },
    set activeCodexClientLifecycleLease(value) {
      lease = value
    },
    codexProviderClientCohorts: new CodexClientRunCohortRegistry<
      CodexProviderClientCohortResource<FakeClient>
    >(),
    codexClientLifecycleQueue: new CodexClientLifecycleQueue(),
    CodexClientLifecycleAcquireAbortedError: AcquireAbortedError,
    poisonWorkspaceLockMutationAdmission: vi.fn(),
    AppStore: {
      getSettings: () => settings,
      getRuntimeProfiles: () => runtimeProfiles,
      resolveExtensionSecretValues: vi.fn(() => [])
    },
    taskwraithMcpBridgeCommandStatus: vi.fn(() => ({ available: true, command: '/bridge' })),
    buildUserMcpLaunchServers: vi.fn(buildUserMcpLaunchServers),
    managedUserMcpLaunchAllowlistPolicy: vi.fn(() => undefined),
    validateUserMcpPluginProvenance: vi.fn(() => undefined),
    // Encode every option so real profile-fence predicates determine the key.
    // This boundary is a fake bridge argv builder; it launches nothing.
    taskwraithMcpBridgeArgs: vi.fn((socket, options) => [socket, JSON.stringify(options)]),
    geminiMcpSocketPath: () => '/bridge.sock',
    createHash,
    CodexAppServerClient: FakeClient,
    taskWraithCodexHome: () => '/private/codex',
    process: { env: {} },
    acquireCodexCredentialLeaseIfConsented: vi.fn(async () => null),
    shouldRestartCodexAppServerForMcpConfig,
    codexAppServerStartupLeaseCount: 0,
    runManager: { getActiveByProvider: () => activeSessions },
    codexThreadAdmissionRegistry: { activeLaneReservationCount: 0 },
    console: { log: vi.fn() },
    disposeCodexClientForOwnerTransition: vi.fn(async () => undefined),
    finishCodexClientLifecycle: vi.fn(async () => undefined)
  }
  return {
    deps,
    settings,
    activeSessions,
    setRuntimeProfiles: (profiles: RuntimeProfile[]) => {
      runtimeProfiles = profiles
    },
    acquisition: createCodexClientAcquisition(deps)
  }
}

const solo: CodexClientAcquisitionPayload = {
  taskWraithMcpProfileId: profileFence.TASKWRAITH_FRESH_SOLO_GATEWAY_MCP_PROFILE_ID
}
const gateway: CodexClientAcquisitionPayload = {
  taskWraithMcpProfileId: profileFence.TASKWRAITH_FRESH_GATEWAY_MCP_PROFILE_ID
}
const mesh: CodexClientAcquisitionPayload = {
  taskWraithMcpProfileId: profileFence.TASKWRAITH_FRESH_GATEWAY_MESH_MCP_PROFILE_ID
}

function runtime(id: string, provider: RuntimeProfile['provider'] = 'codex'): RuntimeProfile {
  return {
    id,
    name: id,
    provider,
    scope: 'workspace',
    workspaceMode: 'local',
    networkPolicy: 'inherit',
    persistence: 'reusable',
    env: { CODEX_HOME: '/profiles/' + id },
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z'
  }
}

describe('Codex client startup configuration', () => {
  it('hashes runtime profile, effective MCP configuration and credential consent with SHA-256', () => {
    const { acquisition, settings } = fixture()
    const profile = runtime('one')
    const configuration = acquisition.resolveCodexClientStartupConfiguration(
      profile,
      solo.taskWraithMcpProfileId
    )
    expect(configuration.compatibilityKey).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            runtimeProfile: profile,
            mcpConfig: configuration.mcpConfig,
            credentialLeaseConsent: false
          })
        )
        .digest('hex')
    )
    expect(
      acquisition.resolveCodexClientStartupConfiguration(
        runtime('two'),
        solo.taskWraithMcpProfileId
      ).compatibilityKey
    ).not.toBe(configuration.compatibilityKey)
    settings.codexReuseExistingLogin = true
    expect(
      acquisition.resolveCodexClientStartupConfiguration(profile, solo.taskWraithMcpProfileId)
        .compatibilityKey
    ).not.toBe(configuration.compatibilityKey)
  })

  it('drops MCP profile differences when the bridge is disabled and there are no user servers (S8)', () => {
    const { acquisition, settings, deps } = fixture()
    settings.geminiMcpBridgeEnabled = false
    const configurations = [solo, gateway, mesh].map((payload) =>
      acquisition.resolveCodexClientStartupConfiguration(undefined, payload.taskWraithMcpProfileId)
    )
    expect(configurations.map((value) => value.mcpConfig)).toEqual([null, null, null])
    expect(new Set(configurations.map((value) => value.compatibilityKey)).size).toBe(1)
    expect(deps.taskwraithMcpBridgeArgs).not.toHaveBeenCalled()
    const explicitNull = acquisition.resolveCodexClientStartupConfiguration(null)
    expect(explicitNull.compatibilityKey).toBe(configurations[0].compatibilityKey)
    expect(configurations[0].runtimeProfile).toBeUndefined()
    expect(explicitNull.runtimeProfile).toBeNull()
  })

  it('keeps solo-gateway, gateway and gateway-mesh keys distinct with the bridge enabled', () => {
    const { acquisition } = fixture()
    const configurations = [solo, gateway, mesh].map((payload) =>
      acquisition.resolveCodexClientStartupConfiguration(null, payload.taskWraithMcpProfileId)
    )
    expect(new Set(configurations.map((value) => value.compatibilityKey)).size).toBe(3)
    expect(configurations.every((value) => value.mcpConfig?.enabled)).toBe(true)
    expect(acquisition.resolveCodexClientStartupConfiguration(null).compatibilityKey).toBe(
      configurations[1].compatibilityKey
    )
  })

  it('uses effective user servers and preserves profile-bearing config with the bridge disabled', () => {
    const { acquisition, deps, settings } = fixture()
    settings.geminiMcpBridgeEnabled = false
    vi.mocked(deps.buildUserMcpLaunchServers).mockReturnValue([
      { serverName: 'user', transport: 'http', url: 'https://example.test/mcp' }
    ])
    const first = acquisition.resolveCodexClientStartupConfiguration(
      null,
      solo.taskWraithMcpProfileId
    )
    const second = acquisition.resolveCodexClientStartupConfiguration(
      null,
      mesh.taskWraithMcpProfileId
    )
    expect(first.mcpConfig?.enabled).toBe(false)
    expect(first.mcpConfig?.userMcpServers).toHaveLength(1)
    expect(first.compatibilityKey).not.toBe(second.compatibilityKey)
    expect(deps.buildUserMcpLaunchServers).toHaveBeenCalledWith(settings.userMcpServers, {
      supportedTransports: ['stdio', 'http'],
      allowlistPolicy: undefined,
      resolveSecretValues: expect.any(Function),
      validatePluginProvenance: deps.validateUserMcpPluginProvenance
    })
  })

  it('treats an unavailable bridge like a disabled bridge', () => {
    const { acquisition, deps } = fixture()
    vi.mocked(deps.taskwraithMcpBridgeCommandStatus).mockReturnValue({
      available: false,
      command: '/missing'
    })
    expect(acquisition.resolveCodexClientStartupConfiguration().mcpConfig).toBeNull()
  })
})

describe('Codex acquisition parity', () => {
  it('joins a compatible cohort and tears down only after its last owner', async () => {
    const { acquisition, deps } = fixture()
    const first = await acquisition.acquireCodexProviderClientRunLease(gateway, 'first', null)
    const second = await acquisition.acquireCodexProviderClientRunLease(gateway, 'second', null)
    expect(second.lifecycleLease).toBe(first.lifecycleLease)
    expect(second.client).toBe(first.client)
    expect(deps.disposeCodexClientForOwnerTransition).toHaveBeenCalledTimes(1)
    await first.cohortLease.release()
    expect(deps.finishCodexClientLifecycle).not.toHaveBeenCalled()
    expect(deps.activeCodexClientLifecycleLease).toBe(first.lifecycleLease)
    await second.cohortLease.release()
    await second.cohortLease.release()
    expect(deps.finishCodexClientLifecycle).toHaveBeenCalledExactlyOnceWith(
      first.client,
      first.lifecycleLease
    )
    expect(deps.activeCodexClientLifecycleLease).toBeNull()
  })

  it('closes admission and queues an incompatible arrival until the cohort last owner releases', async () => {
    const { acquisition, deps } = fixture()
    const first = await acquisition.acquireCodexProviderClientRunLease(solo, 'first', null)
    const second = await acquisition.acquireCodexProviderClientRunLease(solo, 'second', null)
    const stop = vi.spyOn(deps.codexProviderClientCohorts, 'stopAccepting')
    const enqueue = vi.spyOn(deps.codexClientLifecycleQueue, 'enqueue')
    let arrived = false
    const pending = acquisition
      .acquireCodexProviderClientRunLease(mesh, 'third', null)
      .then((lease) => {
        arrived = true
        return lease
      })
    expect(stop).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledOnce()
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0])
    await first.cohortLease.release()
    expect(arrived).toBe(false)
    expect(deps.finishCodexClientLifecycle).not.toHaveBeenCalled()
    await second.cohortLease.release()
    const third = await pending
    expect(third.lifecycleLease).not.toBe(first.lifecycleLease)
    await third.cohortLease.release()
  })

  it('does not reconsider a compatible queued request at the front (current behaviour, M3 step 3 target)', async () => {
    const { acquisition, deps } = fixture()
    const join = vi.spyOn(deps.codexProviderClientCohorts, 'tryJoin')
    const open = vi.spyOn(deps.codexProviderClientCohorts, 'open')
    const first = await acquisition.acquireCodexProviderClientRunLease(solo, 'first', null)
    const secondPending = acquisition.acquireCodexProviderClientRunLease(mesh, 'second', null)
    let thirdAcquired = false
    const thirdPending = acquisition
      .acquireCodexProviderClientRunLease(mesh, 'third', null)
      .then((value) => {
        thirdAcquired = true
        return value
      })
    await first.cohortLease.release()
    const second = await secondPending
    expect(thirdAcquired).toBe(false)
    await second.cohortLease.release()
    const third = await thirdPending
    expect(join.mock.calls.map(([owner]) => owner)).toEqual(['first', 'second', 'third'])
    expect(open.mock.calls.map(([owner]) => owner)).toEqual(['first', 'second', 'third'])
    expect(third.lifecycleLease).not.toBe(second.lifecycleLease)
    await third.cohortLease.release()
  })

  it('lets a compatible newcomer overtake an older queued request (current behaviour, M3 step 3 target)', async () => {
    const { acquisition } = fixture()
    const first = await acquisition.acquireCodexProviderClientRunLease(solo, 'first', null)
    const secondPending = acquisition.acquireCodexProviderClientRunLease(mesh, 'second', null)
    let olderAcquired = false
    const olderPending = acquisition
      .acquireCodexProviderClientRunLease(mesh, 'older', null)
      .then((value) => {
        olderAcquired = true
        return value
      })
    await first.cohortLease.release()
    const second = await secondPending
    const newcomer = await acquisition.acquireCodexProviderClientRunLease(mesh, 'newcomer', null)
    expect(newcomer.lifecycleLease).toBe(second.lifecycleLease)
    expect(olderAcquired).toBe(false)
    await second.cohortLease.release()
    expect(olderAcquired).toBe(false)
    await newcomer.cohortLease.release()
    const older = await olderPending
    expect(older.lifecycleLease).not.toBe(newcomer.lifecycleLease)
    await older.cohortLease.release()
  })

  it('pins the owner-domain hash and isolates two runs even when their non-null owner matches', async () => {
    const { acquisition, deps } = fixture()
    const open = vi.spyOn(deps.codexProviderClientCohorts, 'open')
    const configuration = acquisition.resolveCodexClientStartupConfiguration(
      null,
      gateway.taskWraithMcpProfileId
    )
    const first = await acquisition.acquireCodexProviderClientRunLease(gateway, 'first', 'owner')
    expect(open.mock.calls[0][1]).toBe(
      createHash('sha256')
        .update(configuration.compatibilityKey + '\0owner\0first')
        .digest('hex')
    )
    const secondPending = acquisition.acquireCodexProviderClientRunLease(gateway, 'second', 'owner')
    await first.cohortLease.release()
    const second = await secondPending
    expect(second.lifecycleLease).not.toBe(first.lifecycleLease)
    expect(second.client.setWorkspaceLockOwnerId).toHaveBeenLastCalledWith('owner')
    await second.cohortLease.release()
  })

  it('cancels a queued arrival without releasing its predecessor lifecycle', async () => {
    const { acquisition, deps } = fixture()
    const first = await acquisition.acquireCodexProviderClientRunLease(solo, 'first', null)
    const abort = new AbortController()
    const pending = acquisition.acquireCodexProviderClientRunLease(
      { ...mesh, providerSetupAbortSignal: abort.signal },
      'cancelled',
      null
    )
    const rejected = expect(pending).rejects.toBeInstanceOf(AcquireAbortedError)
    abort.abort()
    await rejected
    expect(deps.activeCodexClientLifecycleLease).toBe(first.lifecycleLease)
    const next = acquisition.acquireCodexProviderClientRunLease(mesh, 'next', null)
    await first.cohortLease.release()
    await (await next).cohortLease.release()
  })

  it('releases an acquired lifecycle after owner-transition failure', async () => {
    const { acquisition, deps } = fixture()
    vi.mocked(deps.disposeCodexClientForOwnerTransition).mockRejectedValueOnce(
      new Error('transition failed')
    )
    await expect(
      acquisition.acquireCodexProviderClientRunLease(gateway, 'failed', null)
    ).rejects.toThrow('transition failed')
    expect(deps.activeCodexClientLifecycleLease).toBeNull()
    const next = await acquisition.acquireCodexProviderClientRunLease(gateway, 'next', null)
    await next.cohortLease.release()
  })

  it('rejects unowned client access and preserves exact lease-loss poisoning', async () => {
    const { acquisition, deps } = fixture()
    const lease = await acquisition.acquireCodexClientLifecycleLease(' maintenance ')
    expect(lease.label).toBe('maintenance')
    expect(() => acquisition.getCodexClient()).toThrow('reserved by maintenance')
    deps.activeCodexClientLifecycleLease = null
    lease.release()
    expect(deps.poisonWorkspaceLockMutationAdmission).toHaveBeenCalledExactlyOnceWith(
      'Codex client lifecycle maintenance lost its exact serialization lease.'
    )
  })
})

describe('Codex client accessor parity', () => {
  it('reuses the shared client, reads source homes lazily and supplies the credential-lease callback', () => {
    const { acquisition, deps, setRuntimeProfiles } = fixture()
    const client = acquisition.getCodexClient()
    expect(client).toBe(deps.codexClient)
    expect(client.setRuntimeProfile).not.toHaveBeenCalled()
    expect(client.constructorArgs[0]).toBe('/private/codex')
    expect(client.constructorArgs[2]?.acquireCredentialLease).toBe(
      deps.acquireCodexCredentialLeaseIfConsented
    )
    deps.process.env.CODEX_HOME = '/environment'
    setRuntimeProfiles([runtime('codex'), runtime('claude', 'claude')])
    const homes = client.constructorArgs[1]
    expect(typeof homes).toBe('function')
    expect(typeof homes === 'function' ? homes() : homes).toEqual([
      '/environment',
      '/profiles/codex'
    ])
    expect(acquisition.getCodexClient(null)).toBe(client)
    expect(client.setRuntimeProfile).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('restarts a stale idle client only after startup, active-turn and admission reservations clear', () => {
    const { acquisition, deps, activeSessions } = fixture()
    const client = acquisition.getCodexClient()
    client.hasStaleMcpConfig.mockReturnValue(true)
    const mutable = deps as { codexAppServerStartupLeaseCount: number }
    mutable.codexAppServerStartupLeaseCount = 1
    acquisition.getCodexClient()
    expect(client.dispose).not.toHaveBeenCalled()
    mutable.codexAppServerStartupLeaseCount = 0
    activeSessions.push({ state: { threadId: 'thread', completed: false } })
    acquisition.getCodexClient()
    expect(client.dispose).not.toHaveBeenCalled()
    activeSessions.length = 0
    const reservations = deps.codexThreadAdmissionRegistry as { activeLaneReservationCount: number }
    reservations.activeLaneReservationCount = 1
    acquisition.getCodexClient()
    expect(client.dispose).not.toHaveBeenCalled()
    reservations.activeLaneReservationCount = 0
    acquisition.getCodexClient()
    expect(client.dispose).toHaveBeenCalledOnce()
  })
})

describe('Codex cohort fairness enabled', () => {
  async function reopenedScenario() {
    const context = fixture(true)
    const { acquisition, deps } = context
    const joins = vi.spyOn(deps.codexProviderClientCohorts, 'tryJoin')
    const first = await acquisition.acquireCodexProviderClientRunLease(solo, 'first', null)
    const secondPending = acquisition.acquireCodexProviderClientRunLease(mesh, 'second', null)
    const olderPending = acquisition.acquireCodexProviderClientRunLease(mesh, 'older', null)
    await first.cohortLease.release()
    const second = await secondPending
    const successfulOwners = () =>
      joins.mock.calls
        .filter((_, index) => joins.mock.results[index].value != null)
        .map(([owner]) => owner)
    return { ...context, second, olderPending, successfulOwners }
  }

  it('joins an older compatible request while it is still behind the active lifecycle slot', async () => {
    const { deps, second, olderPending, successfulOwners } = await reopenedScenario()
    expect(successfulOwners()).toContain('older')
    const older = await olderPending
    expect(older.lifecycleLease).toBe(second.lifecycleLease)
    expect(deps.activeCodexClientLifecycleLease).toBe(second.lifecycleLease)
    await second.cohortLease.release()
    expect(deps.activeCodexClientLifecycleLease).toBe(older.lifecycleLease)
    await older.cohortLease.release()
  })

  it('enrols the older compatible waiter before a newcomer joins the reopened cohort', async () => {
    const { acquisition, second, olderPending, successfulOwners } = await reopenedScenario()
    const newcomer = await acquisition.acquireCodexProviderClientRunLease(mesh, 'newcomer', null)
    expect(successfulOwners()).toEqual(['older', 'newcomer'])
    const older = await olderPending
    expect(older.lifecycleLease).toBe(newcomer.lifecycleLease)
    await second.cohortLease.release()
    await newcomer.cohortLease.release()
    await older.cohortLease.release()
  })

  it('reopens the cohort after the last queued lifecycle abort', async () => {
    const { acquisition, deps } = fixture(true)
    const first = await acquisition.acquireCodexProviderClientRunLease(gateway, 'first', null)
    const abort = new AbortController()
    const pending = acquisition.acquireCodexClientLifecycleLease('maintenance', abort.signal)
    const rejected = expect(pending).rejects.toBeInstanceOf(AcquireAbortedError)
    abort.abort()
    await rejected
    const borrowed = deps.codexProviderClientCohorts.tryBorrow('read-after-abort')
    expect(borrowed).not.toBeNull()
    await borrowed!.release()
    const compatible = await acquisition.acquireCodexProviderClientRunLease(gateway, 'next', null)
    expect(compatible.lifecycleLease).toBe(first.lifecycleLease)
    expect(first.client.setMcpConfig).toHaveBeenCalledOnce()
    await first.cohortLease.release()
    await compatible.cohortLease.release()
  })

  it('keeps remaining destructive demand ahead of borrowers and new compatible traffic', async () => {
    const { acquisition, deps } = fixture(true)
    const first = await acquisition.acquireCodexProviderClientRunLease(gateway, 'first', null)
    const abort = new AbortController()
    const cancelled = acquisition.acquireCodexClientLifecycleLease('cancelled', abort.signal)
    const rejected = expect(cancelled).rejects.toBeInstanceOf(AcquireAbortedError)
    const remaining = acquisition.acquireCodexClientLifecycleLease('remaining')
    abort.abort()
    await rejected
    expect(deps.codexProviderClientCohorts.tryBorrow('read')).toBeNull()
    let nextAcquired = false
    const nextPending = acquisition
      .acquireCodexProviderClientRunLease(gateway, 'next', null)
      .then((lease) => {
        nextAcquired = true
        return lease
      })
    await first.cohortLease.release()
    const exclusive = await remaining
    expect(nextAcquired).toBe(false)
    expect(() => acquisition.getCodexClient()).toThrow('reserved by remaining')
    exclusive.release()
    await (await nextPending).cohortLease.release()
  })

  it('gives a neutral borrower live ownership during a compatible reopen without retargeting', async () => {
    const { acquisition, deps, second, olderPending, successfulOwners } = await reopenedScenario()
    expect(successfulOwners()).toContain('older')
    const configured = second.client.setMcpConfig.mock.calls.length
    const borrowed = deps.codexProviderClientCohorts.tryBorrow('neutral-read')
    expect(borrowed?.resource.client).toBe(second.client)
    const older = await olderPending
    await second.cohortLease.release()
    await older.cohortLease.release()
    expect(deps.activeCodexClientLifecycleLease).toBe(second.lifecycleLease)
    expect(second.client.setMcpConfig).toHaveBeenCalledTimes(configured)
    expect(() => acquisition.getCodexClient()).toThrow('reserved by provider-run:second')
    await borrowed!.release()
    expect(deps.activeCodexClientLifecycleLease).toBeNull()
  })

  it('drains a reopened cohort for older incompatible work despite continuing compatible arrivals', async () => {
    const { acquisition, deps } = fixture(true)
    const first = await acquisition.acquireCodexProviderClientRunLease(solo, 'first', null)
    const secondPending = acquisition.acquireCodexProviderClientRunLease(mesh, 'second', null)
    const olderPending = acquisition.acquireCodexProviderClientRunLease(gateway, 'older', null)
    await first.cohortLease.release()
    const second = await secondPending
    expect(deps.codexProviderClientCohorts.admissionState()?.accepting).toBe(false)
    const arrivals = Array.from({ length: 16 }, (_, index) =>
      acquisition.acquireCodexProviderClientRunLease(mesh, 'new-' + index, null)
    )
    await second.cohortLease.release()
    const older = await olderPending
    expect(older.lifecycleLease.label).toBe('provider-run:older')
    await older.cohortLease.release()
    const batch = await Promise.all(arrivals)
    expect(new Set(batch.map((lease) => lease.lifecycleLease)).size).toBe(1)
    expect(batch[0].lifecycleLease).not.toBe(second.lifecycleLease)
    await Promise.all(batch.map((lease) => lease.cohortLease.release()))
    expect(deps.activeCodexClientLifecycleLease).toBeNull()
  })

  it('releases a compatible join aborted before delivery to the provider caller', async () => {
    const { acquisition, deps } = fixture(true)
    const first = await acquisition.acquireCodexProviderClientRunLease(gateway, 'first', null)
    const abort = new AbortController()
    const join = deps.codexProviderClientCohorts.tryJoin.bind(deps.codexProviderClientCohorts)
    vi.spyOn(deps.codexProviderClientCohorts, 'tryJoin').mockImplementation((owner, key) => {
      const lease = join(owner, key)
      if (owner === 'cancelled') abort.abort()
      return lease
    })
    await expect(
      acquisition.acquireCodexProviderClientRunLease(
        { ...gateway, providerSetupAbortSignal: abort.signal },
        'cancelled',
        null
      )
    ).rejects.toBeInstanceOf(AcquireAbortedError)
    expect(deps.poisonWorkspaceLockMutationAdmission).not.toHaveBeenCalled()
    await first.cohortLease.release()
    expect(deps.finishCodexClientLifecycle).toHaveBeenCalledOnce()
    expect(deps.activeCodexClientLifecycleLease).toBeNull()
  })

  it('retains the exact lifecycle poison check on a compatible join', async () => {
    const { acquisition, deps } = fixture(true)
    const first = await acquisition.acquireCodexProviderClientRunLease(gateway, 'first', null)
    deps.activeCodexClientLifecycleLease = {
      token: Symbol('foreign'),
      label: 'foreign',
      release: vi.fn()
    }
    await expect(
      acquisition.acquireCodexProviderClientRunLease(gateway, 'next', null)
    ).rejects.toThrow('Codex compatible client cohort lost lifecycle ownership.')
    expect(deps.poisonWorkspaceLockMutationAdmission).toHaveBeenCalledExactlyOnceWith(
      'Codex run next joined a client cohort without its exact lifecycle lease.'
    )
    expect(deps.codexProviderClientCohorts.admissionState()?.accepting).toBe(false)
    deps.activeCodexClientLifecycleLease = first.lifecycleLease
    await first.cohortLease.release()
  })

  it('releases the lifecycle FIFO after a transition failure', async () => {
    const { acquisition, deps } = fixture(true)
    vi.mocked(deps.disposeCodexClientForOwnerTransition).mockRejectedValueOnce(
      new Error('transition failed')
    )
    await expect(
      acquisition.acquireCodexProviderClientRunLease(gateway, 'failed', null)
    ).rejects.toThrow('transition failed')
    expect(deps.activeCodexClientLifecycleLease).toBeNull()
    const next = await acquisition.acquireCodexProviderClientRunLease(gateway, 'next', null)
    await next.cohortLease.release()
  })

  it('keeps the selected scheduling mode stable while an owner is live', async () => {
    const { acquisition, deps } = fixture(true)
    const first = await acquisition.acquireCodexProviderClientRunLease(gateway, 'first', null)
    Object.defineProperty(deps, 'flags', { value: { cohortFairness: false } })
    const abort = new AbortController()
    const pending = acquisition.acquireCodexClientLifecycleLease('cancelled', abort.signal)
    const rejected = expect(pending).rejects.toBeInstanceOf(AcquireAbortedError)
    abort.abort()
    await rejected
    const borrowed = deps.codexProviderClientCohorts.tryBorrow('read-after-abort')
    expect(borrowed).not.toBeNull()
    await borrowed!.release()
    await first.cohortLease.release()
  })
})

describe('queued lifecycle cancellation baseline', () => {
  it('keeps the cohort closed after the last queued lifecycle abort (current behaviour, M3 step 3 target)', async () => {
    const { acquisition, deps } = fixture()
    const first = await acquisition.acquireCodexProviderClientRunLease(gateway, 'first', null)
    const controller = new AbortController()
    const pending = acquisition.acquireCodexClientLifecycleLease('maintenance', controller.signal)
    const rejected = expect(pending).rejects.toBeInstanceOf(AcquireAbortedError)
    controller.abort()
    await rejected

    expect(deps.codexProviderClientCohorts.tryBorrow('read-after-abort')).toBeNull()
    let acquired = false
    const nextPending = acquisition
      .acquireCodexProviderClientRunLease(gateway, 'next', null)
      .then((lease) => {
        acquired = true
        return lease
      })
    await Promise.resolve()
    expect(acquired).toBe(false)
    await first.cohortLease.release()
    const next = await nextPending
    expect(next.lifecycleLease).not.toBe(first.lifecycleLease)
    await next.cohortLease.release()
  })
})

describe('Codex accessor configuration forwarding', () => {
  it('restarts for stale credential consent when the MCP configuration is current', () => {
    const { acquisition } = fixture()
    const client = acquisition.getCodexClient()
    expect(client.hasStaleMcpConfig()).toBe(false)
    client.hasStaleCredentialLeaseConsent.mockReturnValue(true)

    acquisition.getCodexClient()
    expect(client.dispose).toHaveBeenCalledOnce()
    client.hasStaleCredentialLeaseConsent.mockReturnValue(false)
    acquisition.getCodexClient()
    expect(client.dispose).toHaveBeenCalledOnce()
  })

  it('forwards actual runtime profiles on initial and subsequent accessor calls', () => {
    const { acquisition } = fixture()
    const initial = runtime('initial')
    const replacement = runtime('replacement')
    const client = acquisition.getCodexClient(initial)

    expect(client.setRuntimeProfile).toHaveBeenCalledExactlyOnceWith(initial)
    expect(acquisition.getCodexClient(replacement)).toBe(client)
    expect(client.setRuntimeProfile.mock.calls).toEqual([[initial], [replacement]])
  })
})

describe('live acquisition dependencies', () => {
  it('does not read any dependency while constructing the factory', () => {
    const { deps } = fixture()
    const reads: PropertyKey[] = []
    const live = new Proxy(deps, {
      get(target, property, receiver) {
        reads.push(property)
        return Reflect.get(target, property, receiver)
      }
    })

    const acquisition = createCodexClientAcquisition(live)
    expect(reads).toEqual([])
    acquisition.resolveCodexClientStartupConfiguration()
    expect(reads).toContain('AppStore')
    expect(reads).toContain('managedUserMcpLaunchAllowlistPolicy')
  })

  it('uses a client swapped into the shared binding after an earlier accessor call', () => {
    const { acquisition, deps } = fixture()
    const first = acquisition.getCodexClient()
    const replacement = new FakeClient('/replacement')
    deps.codexClient = replacement

    expect(acquisition.getCodexClient(null)).toBe(replacement)
    expect(replacement.setRuntimeProfile).toHaveBeenCalledExactlyOnceWith(null)
    expect(replacement.setMcpConfig).toHaveBeenCalledOnce()
    expect(first.setMcpConfig).toHaveBeenCalledOnce()
  })

  it('reads the startup lease count through a live getter on every restart decision', () => {
    const { acquisition, deps } = fixture()
    let startupLeaseCount = 0
    Object.defineProperty(deps, 'codexAppServerStartupLeaseCount', {
      get: () => startupLeaseCount
    })
    const client = acquisition.getCodexClient()
    client.hasStaleMcpConfig.mockReturnValue(true)

    startupLeaseCount = 1
    acquisition.getCodexClient()
    expect(client.dispose).not.toHaveBeenCalled()
    startupLeaseCount = 0
    acquisition.getCodexClient()
    expect(client.dispose).toHaveBeenCalledOnce()
    startupLeaseCount = 2
    acquisition.getCodexClient()
    expect(client.dispose).toHaveBeenCalledOnce()
  })

  it('honours a replaced lifecycle binding and reads the latest poison callback on release', async () => {
    const { acquisition, deps } = fixture()
    const originalPoison = vi.fn()
    const replacementPoison = vi.fn()
    let poison = originalPoison
    Object.defineProperty(deps, 'poisonWorkspaceLockMutationAdmission', {
      get: () => poison
    })
    const lease = await acquisition.acquireCodexClientLifecycleLease('original')
    const replacement = {
      token: Symbol('replacement'),
      label: 'replacement',
      release: vi.fn()
    }
    deps.activeCodexClientLifecycleLease = replacement
    poison = replacementPoison

    expect(() => acquisition.getCodexClient(undefined, undefined, lease)).toThrow(
      'reserved by replacement'
    )
    lease.release()
    expect(originalPoison).not.toHaveBeenCalled()
    expect(replacementPoison).toHaveBeenCalledExactlyOnceWith(
      'Codex client lifecycle original lost its exact serialization lease.'
    )
    expect(deps.activeCodexClientLifecycleLease).toBe(replacement)
    expect(replacement.release).not.toHaveBeenCalled()
  })

  it('reads a replaced MCP allowlist callback after factory creation and prior resolution', () => {
    const { acquisition, deps, settings } = fixture()
    const stdioPolicy = { allowedTransports: ['stdio'] } as const
    const httpPolicy = { allowedTransports: ['http'] } as const
    let resolvePolicy: NonNullable<
      CodexClientAcquisitionDependencies<FakeClient>['managedUserMcpLaunchAllowlistPolicy']
    > = () => stdioPolicy
    Object.defineProperty(deps, 'managedUserMcpLaunchAllowlistPolicy', {
      get: () => resolvePolicy
    })

    acquisition.resolveCodexClientStartupConfiguration()
    expect(deps.buildUserMcpLaunchServers).toHaveBeenLastCalledWith(
      settings.userMcpServers,
      expect.objectContaining({ allowlistPolicy: stdioPolicy })
    )
    resolvePolicy = () => httpPolicy
    acquisition.resolveCodexClientStartupConfiguration()
    expect(deps.buildUserMcpLaunchServers).toHaveBeenLastCalledWith(
      settings.userMcpServers,
      expect.objectContaining({ allowlistPolicy: httpPolicy })
    )
  })

  it('uses the current teardown callback when a previously opened cohort closes', async () => {
    const { acquisition, deps } = fixture()
    const originalFinish = deps.finishCodexClientLifecycle
    const lease = await acquisition.acquireCodexProviderClientRunLease(gateway, 'run', null)
    const replacementFinish = vi.fn(async () => undefined)
    Object.defineProperty(deps, 'finishCodexClientLifecycle', {
      get: () => replacementFinish
    })

    await lease.cohortLease.release()
    expect(originalFinish).not.toHaveBeenCalled()
    expect(replacementFinish).toHaveBeenCalledExactlyOnceWith(lease.client, lease.lifecycleLease)
    expect(deps.activeCodexClientLifecycleLease).toBeNull()
  })
})
