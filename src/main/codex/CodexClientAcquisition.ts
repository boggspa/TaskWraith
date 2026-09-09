import type { createHash } from 'node:crypto'
import type {
  CodexAppServerClient,
  CodexAppServerCredentialLease,
  CodexMcpTaskWraithConfig
} from '../CodexAppServerClient'
import type { shouldRestartCodexAppServerForMcpConfig } from '../CodexRunRouting'
import type {
  buildUserMcpLaunchServers,
  BuildUserMcpLaunchServersOptions,
  UserMcpLaunchAllowlistPolicy
} from '../UserMcpServers'
import type * as McpSessionProfileFence from '../mcp/McpSessionProfileFence'
import type { RuntimeProfile, TaskWraithMcpProfileId } from '../store/types'
import type { CodexClientLifecycleQueue } from './CodexClientLifecycleQueue'
import { CodexClientWaiterQueue } from './CodexClientWaiterQueue'
import type {
  CodexClientRunCohortLease,
  CodexClientRunCohortRegistry
} from './CodexClientRunCohort'

export interface CodexClientLifecycleLease {
  readonly token: symbol
  readonly label: string
  release(): void
}

export type CodexAcquisitionClient = Pick<
  CodexAppServerClient,
  | 'setRuntimeProfile'
  | 'setMcpConfig'
  | 'setCredentialLeaseConsent'
  | 'hasStaleMcpConfig'
  | 'hasStaleCredentialLeaseConsent'
  | 'dispose'
  | 'setWorkspaceLockOwnerId'
>

export interface CodexProviderClientCohortResource<TClient> {
  readonly client: TClient
  readonly lifecycleLease: CodexClientLifecycleLease
}

export interface CodexProviderClientRunLease<TClient> {
  readonly client: TClient
  readonly lifecycleLease: CodexClientLifecycleLease
  readonly cohortLease: CodexClientRunCohortLease<CodexProviderClientCohortResource<TClient>>
}

export interface CodexClientStartupConfiguration {
  readonly runtimeProfile: RuntimeProfile | null | undefined
  readonly mcpConfig: CodexMcpTaskWraithConfig | null
  readonly credentialLeaseConsent: boolean
  readonly compatibilityKey: string
}

export interface CodexClientAcquisitionPayload {
  runtimeProfile?: RuntimeProfile | null
  taskWraithMcpProfileId?: TaskWraithMcpProfileId | null
  providerSetupAbortSignal?: AbortSignal
}

type CodexClientActiveRunState = NonNullable<
  Parameters<typeof shouldRestartCodexAppServerForMcpConfig>[0]['activeStates'][number]
>

type ProfileFenceDependencies = Pick<
  typeof McpSessionProfileFence,
  | 'TASKWRAITH_FRESH_GATEWAY_MCP_PROFILE_ID'
  | 'isGatewayTaskWraithMcpProfile'
  | 'isSoloTaskWraithMcpProfile'
  | 'isPortableEnsembleControlMcpProfile'
  | 'isMeshCanvasDirectTaskWraithMcpProfile'
  | 'isMeshTopologyDirectTaskWraithMcpProfile'
  | 'isSketchCanvasDirectTaskWraithMcpProfile'
  | 'isGatewayV13DirectTaskWraithMcpProfile'
  | 'isPermissionOpportunityDirectTaskWraithMcpProfile'
>

export interface CodexClientAcquisitionDependencies<
  TClient extends CodexAcquisitionClient
> extends ProfileFenceDependencies {
  // Mutable host bindings must remain live getters, including readonly ports
  // such as the startup lease count and policy callbacks. Readonly describes
  // how acquisition consumes them; it does not promise a fixed value.
  // These two shared bindings additionally require setters for transitions.
  codexClient: TClient | null
  activeCodexClientLifecycleLease: CodexClientLifecycleLease | null
  readonly codexProviderClientCohorts: CodexClientRunCohortRegistry<
    CodexProviderClientCohortResource<TClient>
  >
  readonly flags?: { readonly cohortFairness?: boolean }
  readonly codexClientLifecycleQueue: CodexClientLifecycleQueue
  readonly CodexClientLifecycleAcquireAbortedError: new (label: string) => Error
  readonly poisonWorkspaceLockMutationAdmission: (reason: string) => void
  readonly AppStore: {
    getSettings(): {
      userMcpServers?: Parameters<typeof buildUserMcpLaunchServers>[0]
      geminiMcpBridgeEnabled?: boolean
      codexReuseExistingLogin?: boolean
    }
    getRuntimeProfiles(): RuntimeProfile[]
    resolveExtensionSecretValues: NonNullable<
      BuildUserMcpLaunchServersOptions['resolveSecretValues']
    >
  }
  readonly taskwraithMcpBridgeCommandStatus: () => { available: boolean; command: string }
  readonly buildUserMcpLaunchServers: typeof buildUserMcpLaunchServers
  readonly managedUserMcpLaunchAllowlistPolicy?:
    | (() => UserMcpLaunchAllowlistPolicy | undefined)
    | null
  readonly validateUserMcpPluginProvenance: NonNullable<
    BuildUserMcpLaunchServersOptions['validatePluginProvenance']
  >
  readonly taskwraithMcpBridgeArgs: (
    socketPath: string,
    options: {
      gatewaySubset: boolean
      soloSubset: boolean
      portableEnsembleControl: boolean
      meshDirect: boolean
      meshTopologyDirect: boolean
      sketchDirect: boolean
      orchestrationDirect: boolean
      permissionOpportunityDirect: boolean
    }
  ) => string[]
  readonly geminiMcpSocketPath: () => string
  readonly createHash: typeof createHash
  readonly CodexAppServerClient: new (
    ...args: ConstructorParameters<typeof CodexAppServerClient>
  ) => TClient
  readonly taskWraithCodexHome: () => string
  readonly process: { readonly env: NodeJS.ProcessEnv }
  readonly acquireCodexCredentialLeaseIfConsented: (
    codexHome: string
  ) => Promise<CodexAppServerCredentialLease | null>
  readonly shouldRestartCodexAppServerForMcpConfig: typeof shouldRestartCodexAppServerForMcpConfig
  readonly codexAppServerStartupLeaseCount: number
  readonly runManager: {
    getActiveByProvider(provider: 'codex'): readonly { state?: unknown }[]
  }
  readonly codexThreadAdmissionRegistry: { readonly activeLaneReservationCount: number }
  readonly console: Pick<Console, 'log'>
  readonly disposeCodexClientForOwnerTransition: (lease: CodexClientLifecycleLease) => Promise<void>
  readonly finishCodexClientLifecycle: (
    client: TClient,
    lease: CodexClientLifecycleLease
  ) => Promise<void>
}

/**
 * Acquisition extracted from index.ts at d93fb8a65; wired from the
 * composition root at adfdd1400.
 * Default mode preserves the existing compatibility and FIFO behavior.
 * The composition root supplies flags.cohortFairness from
 * process.env.TASKWRAITH_CODEX_COHORT_FAIRNESS === '1'; this module never reads it.
 * Mode is selected on the first lease request and held for this factory's
 * lifetime, so a flag change cannot mix schedulers with queued work in flight.
 * Process launch, credential ownership and teardown remain supplied by the root.
 */
export function createCodexClientAcquisition<TClient extends CodexAcquisitionClient>(
  deps: CodexClientAcquisitionDependencies<TClient>
) {
  let fairWaiters:
    | CodexClientWaiterQueue<CodexProviderClientCohortResource<TClient>>
    | null
    | undefined

  function fairnessQueue() {
    if (fairWaiters === undefined) {
      fairWaiters =
        deps.flags?.cohortFairness === true
          ? new CodexClientWaiterQueue({
              lifecycleQueue: () => deps.codexClientLifecycleQueue,
              cohorts: () => deps.codexProviderClientCohorts,
              canReopen: (resource) =>
                deps.activeCodexClientLifecycleLease === resource.lifecycleLease
            })
          : null
    }
    return fairWaiters
  }

  async function acquireCodexClientLifecycleLease(
    label: string,
    signal?: AbortSignal
  ): Promise<CodexClientLifecycleLease> {
    const normalizedLabel = label.trim()
    if (!normalizedLabel) throw new Error('Codex client lifecycle requires an exact owner label.')
    const fair = fairnessQueue()
    if (fair) {
      const grant = await fair.acquireExclusive(normalizedLabel, signal)
      if (!grant || signal?.aborted) {
        grant?.release()
        throw new deps.CodexClientLifecycleAcquireAbortedError(normalizedLabel)
      }
      return claimCodexClientLifecycleLease(normalizedLabel, grant)
    }
    // An exclusive transition queued behind a provider cohort must eventually
    // run. Close admission before joining the lifecycle tail so later compatible
    // turns cannot starve a profile, credential, maintenance, or teardown change.
    deps.codexProviderClientCohorts.stopAccepting()
    const queueSlot = deps.codexClientLifecycleQueue.enqueue()
    if (!(await queueSlot.waitUntilAcquired(signal)) || signal?.aborted) {
      queueSlot.release()
      throw new deps.CodexClientLifecycleAcquireAbortedError(normalizedLabel)
    }
    return claimCodexClientLifecycleLease(normalizedLabel, queueSlot)
  }

  function claimCodexClientLifecycleLease(
    normalizedLabel: string,
    queueSlot: { release(): void }
  ): CodexClientLifecycleLease {
    if (deps.activeCodexClientLifecycleLease) {
      queueSlot.release()
      throw new Error('Codex client lifecycle serialization was violated.')
    }
    let released = false
    const lease: CodexClientLifecycleLease = {
      token: Symbol(normalizedLabel),
      label: normalizedLabel,
      release: () => {
        if (released) return
        released = true
        if (deps.activeCodexClientLifecycleLease !== lease) {
          deps.poisonWorkspaceLockMutationAdmission(
            `Codex client lifecycle ${normalizedLabel} lost its exact serialization lease.`
          )
          return
        }
        deps.activeCodexClientLifecycleLease = null
        queueSlot.release()
      }
    }
    deps.activeCodexClientLifecycleLease = lease
    return lease
  }
  function resolveCodexClientStartupConfiguration(
    runtimeProfile?: RuntimeProfile | null,
    taskWraithMcpProfileId?: CodexClientAcquisitionPayload['taskWraithMcpProfileId'] | null
  ): CodexClientStartupConfiguration {
    const settings = deps.AppStore.getSettings()
    const bridgeCommandStatus = deps.taskwraithMcpBridgeCommandStatus()
    const userMcpServers = deps.buildUserMcpLaunchServers(settings.userMcpServers, {
      supportedTransports: ['stdio', 'http'],
      allowlistPolicy: deps.managedUserMcpLaunchAllowlistPolicy?.(),
      resolveSecretValues: (refs) => deps.AppStore.resolveExtensionSecretValues(refs),
      validatePluginProvenance: deps.validateUserMcpPluginProvenance
    })
    const taskWraithBridgeEnabled = Boolean(
      settings.geminiMcpBridgeEnabled && bridgeCommandStatus.available
    )
    const mcpProfileId = taskWraithMcpProfileId ?? deps.TASKWRAITH_FRESH_GATEWAY_MCP_PROFILE_ID
    const mcpConfig: CodexMcpTaskWraithConfig | null =
      taskWraithBridgeEnabled || userMcpServers.length > 0
        ? {
            enabled: taskWraithBridgeEnabled,
            bridgeBinaryPath: bridgeCommandStatus.command,
            bridgeArgs: deps.taskwraithMcpBridgeArgs(deps.geminiMcpSocketPath(), {
              gatewaySubset: deps.isGatewayTaskWraithMcpProfile(mcpProfileId),
              soloSubset: deps.isSoloTaskWraithMcpProfile(mcpProfileId),
              portableEnsembleControl: deps.isPortableEnsembleControlMcpProfile(mcpProfileId),
              meshDirect: deps.isMeshCanvasDirectTaskWraithMcpProfile(mcpProfileId),
              meshTopologyDirect: deps.isMeshTopologyDirectTaskWraithMcpProfile(mcpProfileId),
              sketchDirect: deps.isSketchCanvasDirectTaskWraithMcpProfile(mcpProfileId),
              orchestrationDirect: deps.isGatewayV13DirectTaskWraithMcpProfile(mcpProfileId),
              permissionOpportunityDirect:
                deps.isPermissionOpportunityDirectTaskWraithMcpProfile(mcpProfileId)
            }),
            parentProvider: 'codex',
            userMcpServers
          }
        : null
    const credentialLeaseConsent = Boolean(settings.codexReuseExistingLogin)
    const compatibilityKey = deps
      .createHash('sha256')
      .update(
        JSON.stringify({
          runtimeProfile: runtimeProfile ?? null,
          mcpConfig,
          credentialLeaseConsent
        })
      )
      .digest('hex')
    return { runtimeProfile, mcpConfig, credentialLeaseConsent, compatibilityKey }
  }

  function getCodexClient(
    runtimeProfile?: RuntimeProfile | null,
    taskWraithMcpProfileId?: CodexClientAcquisitionPayload['taskWraithMcpProfileId'] | null,
    lifecycleLease?: CodexClientLifecycleLease,
    resolvedConfiguration?: CodexClientStartupConfiguration
  ): TClient {
    if (
      deps.activeCodexClientLifecycleLease &&
      deps.activeCodexClientLifecycleLease !== lifecycleLease
    ) {
      throw new Error(
        `Codex app-server is reserved by ${deps.activeCodexClientLifecycleLease.label}; an unowned helper cannot restart or retarget it.`
      )
    }
    if (!deps.codexClient) {
      deps.codexClient = new deps.CodexAppServerClient(
        deps.taskWraithCodexHome(),
        () => [
          ...(deps.process.env.CODEX_HOME ? [deps.process.env.CODEX_HOME] : []),
          ...deps.AppStore.getRuntimeProfiles()
            .filter((profile) => profile.provider === 'codex')
            .map((profile) => profile.env.CODEX_HOME)
            .filter((candidate): candidate is string => Boolean(candidate?.trim()))
        ],
        { acquireCredentialLease: deps.acquireCodexCredentialLeaseIfConsented }
      )
    }
    const configuration =
      resolvedConfiguration ??
      resolveCodexClientStartupConfiguration(runtimeProfile, taskWraithMcpProfileId)
    if (configuration.runtimeProfile !== undefined) {
      deps.codexClient.setRuntimeProfile(configuration.runtimeProfile ?? null)
    }
    // Phase I2: refresh the MCP config on every accessor call so the
    // toggle in Settings → MCP Bridge takes effect on the NEXT Codex
    // app-server start. A stale idle daemon is restarted below, while an
    // app-server with a transport-owned in-flight turn is never torn down.
    // The TaskWraith bridge mirrors the existing Gemini gate
    // (geminiMcpBridgeEnabled); user-managed stdio/HTTP servers can
    // attach independently through the MCP Servers settings page.
    // Codex's app-server owns one bridge configuration for its process lifetime.
    // A run passes its profile here before a fresh server starts; a running server
    // retains its started profile as a compatibility receipt, never as a Mesh
    // permission grant. Every actual mesh call still hits the current run's
    // signed meshCanvas approval gate in executeGeminiMcpTool.
    deps.codexClient.setMcpConfig(configuration.mcpConfig)
    // Same deferral rule as the MCP config: consent to borrow ~/.codex applies to
    // the NEXT app-server start, so an idle daemon is restarted to pick it up.
    // Without this the toggle looks inert — the daemon that started before it was
    // enabled keeps serving, and Codex keeps asking for a sign-in.
    deps.codexClient.setCredentialLeaseConsent(configuration.credentialLeaseConsent)
    const shouldRestart = deps.shouldRestartCodexAppServerForMcpConfig({
      stale:
        deps.codexClient.hasStaleMcpConfig() || deps.codexClient.hasStaleCredentialLeaseConsent(),
      startupLeaseCount: deps.codexAppServerStartupLeaseCount,
      activeStates: deps.runManager
        .getActiveByProvider('codex')
        .map((session) => session.state as CodexClientActiveRunState | null | undefined),
      // Manual compactions and native reviews hold admission lanes without a
      // RunManager session or startup lease; never dispose the daemon under one.
      admissionReservationCount: deps.codexThreadAdmissionRegistry.activeLaneReservationCount
    })
    if (shouldRestart) {
      deps.console.log('[codex] restarting idle app-server to apply configuration changes')
      deps.codexClient.dispose()
    }
    return deps.codexClient
  }

  async function acquireCodexProviderClientRunLease(
    payload: CodexClientAcquisitionPayload,
    runId: string,
    workspaceLockOwnerId: string | null
  ): Promise<CodexProviderClientRunLease<TClient>> {
    const configuration = resolveCodexClientStartupConfiguration(
      payload.runtimeProfile ?? null,
      payload.taskWraithMcpProfileId
    )
    // A future coarse-lock compatibility mode must remain isolated by its exact
    // owner. Today's operation-scoped policy always supplies null, allowing
    // compatible native threads to share one process without sharing authority.
    const compatibilityKey = deps
      .createHash('sha256')
      .update(
        `${configuration.compatibilityKey}\0${
          workspaceLockOwnerId ? `${workspaceLockOwnerId}\0${runId}` : 'unowned'
        }`
      )
      .digest('hex')
    const fair = fairnessQueue()
    const lifecycleLabel = `provider-run:${runId}`.trim()
    const grant = fair
      ? await fair.acquireCompatible(runId, compatibilityKey, payload.providerSetupAbortSignal)
      : null
    if (fair && !grant) {
      throw new deps.CodexClientLifecycleAcquireAbortedError(lifecycleLabel)
    }
    const joined =
      grant?.kind === 'cohort'
        ? grant.lease
        : fair
          ? null
          : deps.codexProviderClientCohorts.tryJoin(runId, compatibilityKey)
    if (joined) {
      const { client, lifecycleLease } = joined.resource
      if (deps.activeCodexClientLifecycleLease !== lifecycleLease) {
        deps.codexProviderClientCohorts.stopAccepting()
        await joined.release().catch(() => undefined)
        deps.poisonWorkspaceLockMutationAdmission(
          `Codex run ${runId} joined a client cohort without its exact lifecycle lease.`
        )
        throw new Error('Codex compatible client cohort lost lifecycle ownership.')
      }
      if (fair && payload.providerSetupAbortSignal?.aborted) {
        await joined.release()
        throw new deps.CodexClientLifecycleAcquireAbortedError(lifecycleLabel)
      }
      return { client, lifecycleLease, cohortLease: joined }
    }

    let lifecycleLease: CodexClientLifecycleLease
    if (grant?.kind === 'lifecycle') {
      if (payload.providerSetupAbortSignal?.aborted) {
        grant.release()
        throw new deps.CodexClientLifecycleAcquireAbortedError(lifecycleLabel)
      }
      lifecycleLease = claimCodexClientLifecycleLease(lifecycleLabel, grant)
    } else {
      lifecycleLease = await acquireCodexClientLifecycleLease(
        `provider-run:${runId}`,
        payload.providerSetupAbortSignal
      )
    }
    let client: TClient | null = null
    try {
      await deps.disposeCodexClientForOwnerTransition(lifecycleLease)
      client = getCodexClient(
        configuration.runtimeProfile,
        payload.taskWraithMcpProfileId,
        lifecycleLease,
        configuration
      )
      client.setWorkspaceLockOwnerId(workspaceLockOwnerId)
      const cohortLease = deps.codexProviderClientCohorts.open(
        runId,
        compatibilityKey,
        { client, lifecycleLease },
        async () => deps.finishCodexClientLifecycle(client!, lifecycleLease),
        () => lifecycleLease.release()
      )
      fair?.cohortOpened()
      return { client, lifecycleLease, cohortLease }
    } catch (error) {
      try {
        if (client) await deps.finishCodexClientLifecycle(client, lifecycleLease)
      } finally {
        lifecycleLease.release()
      }
      throw error
    }
  }

  return {
    acquireCodexClientLifecycleLease,
    resolveCodexClientStartupConfiguration,
    getCodexClient,
    acquireCodexProviderClientRunLease
  }
}
