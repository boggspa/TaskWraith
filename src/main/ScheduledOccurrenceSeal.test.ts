import { createHmac } from 'node:crypto'
import { parse, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RUNTIME_PROFILE_AUTHORITY_FIELD_POLICY,
  SCHEDULED_LOOP_VERIFIER_SEAT_ID,
  SCHEDULED_OCCURRENCE_OLLAMA_EFFECTIVE_BINARY_SENTINEL,
  buildDefaultRuntimeLaunchAuthority,
  buildEffectiveRuntimeLaunchAuthority,
  buildRuntimeProfileAuthority,
  decodeLegacyScheduledOccurrenceSealV1ForMigration,
  mintScheduledOccurrenceSeal as mintScheduledOccurrenceSealWithPostureResolver,
  scheduledTaskAuthorityDigest,
  verifyScheduledOccurrenceSealAgainstCurrentContext as verifyScheduledOccurrenceSealWithPostureResolver,
  type EffectiveRuntimeLaunchAuthorityInput,
  type ScheduledOccurrenceAuthorityPhase,
  type ScheduledOccurrenceCurrentContext,
  type ScheduledOccurrenceRuntimeSeatContext
} from './ScheduledOccurrenceSeal'
import type { ScheduledOccurrenceAuthorityRoot } from './ScheduledOccurrenceAuthorityRootStore'
import {
  createScheduledOccurrencePostureVerifier,
  type ScheduledOccurrencePostureCapability,
  type ScheduledOccurrencePostureIssueInput
} from './ScheduledOccurrencePostureAuthority'
import { signRunPermissionPosture, type RunPermissionPostureContext } from './RunPermissionPosture'
import type {
  ProviderLaunchAuthorityInput,
  ProviderLaunchAuthorityInputByProvider
} from './ProviderLaunchAuthorityDigest'
import type {
  EffectiveRunPermissions,
  ProviderId,
  RuntimeProfile,
  ScheduledOccurrenceSealV1,
  ScheduledOccurrenceSealV2,
  ScheduledTask,
  WorkflowDefinition,
  WorkflowRunTemplate
} from './store/types'

const ROOT_KEY = Buffer.alloc(32, 19)
const OWNER_RUN_ID = 'run-owner'
const now = '2026-07-14T12:00:00.000Z'
const plannedFor = '2026-07-14T13:00:00.000Z'
const runAt = '2026-07-14T13:05:00.000Z'
const canonicalPath = (value: string): string => value.replace(/\/+$/, '') || '/'
// resolve() keeps these fixtures lexically canonical on every platform; the
// posture/seal validators require `resolve(p) === p`.
const REAL_WORKSPACE_PATH = resolve('/real/workspace')
const OTHER_REAL_PATH = resolve('/real/other')
const OTHER_CODEX_BINARY = resolve('/other/codex')
const EXTERNAL_GRANT_PATH = resolve('/external-two')
const providerBinary = (provider: string): string => resolve(`/opt/taskwraith/bin/${provider}`)

function testAuthorityRoot(
  key: Buffer = ROOT_KEY,
  rootMarker = '1'
): ScheduledOccurrenceAuthorityRoot {
  let liveKey: Buffer | null = Buffer.from(key)
  const mac = (domain: string, payload: Buffer): string => {
    if (liveKey === null) throw new Error('The scheduled occurrence authority root is disposed.')
    return createHmac('sha256', liveKey).update(domain).update(payload).digest('hex')
  }
  const verify = (domain: string, payload: Buffer, value: string): boolean =>
    typeof value === 'string' && mac(domain, payload) === value
  return Object.freeze({
    rootId: `twso-root-v1:${rootMarker.repeat(64)}`,
    sealPayloadMac: (payload) => mac('seal', payload),
    verifySealPayloadMac: (payload, value) => verify('seal', payload, value),
    walPayloadMac: (payload) => mac('wal', payload),
    verifyWalPayloadMac: (payload, value) => verify('wal', payload, value),
    runtimeProfileSetHmac: (payload) => mac('runtime', payload),
    permissionPostureSetHmac: (payload) => mac('posture', payload),
    providerLaunchHmac: (provider, payload) => mac(`provider:${provider}`, payload),
    verifyProviderLaunchHmac: (provider, payload, value) =>
      verify(`provider:${provider}`, payload, value),
    dispose: () => {
      liveKey?.fill(0)
      liveKey = null
    }
  })
}

const ROOT = testAuthorityRoot()
const KEY = ROOT
const POSTURE_SECRET = Buffer.alloc(32, 73)
const POSTURE_VERIFIER = createScheduledOccurrencePostureVerifier(POSTURE_SECRET)
const POSTURE_INPUT_BY_CAPABILITY = new WeakMap<
  object,
  ScheduledOccurrencePostureIssueInput
>()

function refreshPostureCapabilities(current: ScheduledOccurrenceCurrentContext): void {
  const runtimeSeats = current.runtimeSeats.map((seat) => {
    const input = POSTURE_INPUT_BY_CAPABILITY.get(
      seat.permissionPostureCapability as object
    )
    if (!input) return seat
    const capability = POSTURE_VERIFIER.issue(input)
    if (!capability) throw new Error('Test posture capability refresh failed.')
    POSTURE_INPUT_BY_CAPABILITY.set(capability as object, input)
    return { ...seat, permissionPostureCapability: capability }
  })
  ;(current as { runtimeSeats: readonly ScheduledOccurrenceRuntimeSeatContext[] }).runtimeSeats =
    runtimeSeats
}

function mintScheduledOccurrenceSeal(
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  current: ScheduledOccurrenceCurrentContext,
  issuedAt?: string
): ScheduledOccurrenceSealV2 {
  const seal = mintScheduledOccurrenceSealWithPostureResolver(
    authorityRoot,
    POSTURE_VERIFIER.resolver,
    current,
    issuedAt
  )
  refreshPostureCapabilities(current)
  return seal
}

function verifyScheduledOccurrenceSealAgainstCurrentContext(
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  value: unknown,
  current: ScheduledOccurrenceCurrentContext
): ScheduledOccurrenceSealV2 | null {
  refreshPostureCapabilities(current)
  return verifyScheduledOccurrenceSealWithPostureResolver(
    authorityRoot,
    POSTURE_VERIFIER.resolver,
    value,
    current
  )
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'scheduled-1',
    workspaceId: 'workspace-1',
    // Lexical-only binding (never platform-validated); the trailing slash
    // deliberately exercises the test canonicalPath normalizer.
    workspacePath: '/workspace/',
    chatId: 'chat-1',
    provider: 'codex',
    prompt: 'Review the workspace.',
    displayPrompt: 'Review.',
    selectedModelType: 'gpt-5.6-terra',
    customModel: 'custom-a',
    approvalMode: 'default',
    permissionPresetId: 'workspace_write',
    workflowMode: 'normal',
    sessionTrust: false,
    imageAttachments: [
      {
        persistenceVersion: 1,
        id: 'image-1',
        path: '/main-owned/image.png',
        name: 'image.png',
        sha256: '1'.repeat(64),
        mimeType: 'image/png',
        byteLength: 12
      }
    ],
    externalPathGrants: [
      {
        id: 'grant-1',
        provider: 'codex',
        path: '/external',
        kind: 'directory',
        access: 'write',
        duration: 'workspace',
        createdAt: now
      }
    ],
    geminiWorktree: { enabled: true, name: 'scheduled-worktree' },
    codexReasoningEffort: 'high',
    codexServiceTier: 'fast',
    claudeReasoningEffort: 'medium',
    claudeFastMode: false,
    kimiFastMode: false,
    kimiThinkingEnabled: true,
    grokReasoningEffort: 'high',
    cursorReasoningEffort: 'medium',
    cursorFastMode: false,
    runtimeProfileId: 'profile-codex',
    geminiAuthProfileId: 'gemini-auth-1',
    handoffSourceRunId: 'source-run-1',
    runAt,
    timezone: 'Europe/London',
    status: 'due',
    createdAt: now,
    updatedAt: now,
    kind: 'single',
    ...overrides
  }
}

function profile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'profile-codex',
    name: 'Codex scheduled',
    provider: 'codex',
    scope: 'workspace',
    workspaceMode: 'local',
    binaryPath: providerBinary('codex'),
    env: { PUBLIC_MODE: 'review' },
    secretRefs: { env: ['SERVICE_TOKEN'] },
    mcpProfileId: 'taskwraith-full-v1',
    approvalMode: 'default',
    agenticServices: { fileChanges: 'workspace', networkAccess: 'deny' },
    networkPolicy: 'deny',
    persistence: 'reusable',
    containerConfig: {
      image: 'taskwraith/codex:1',
      workdir: '/workspace',
      mounts: [{ source: '/workspace', target: '/workspace', access: 'write' }]
    },
    builtin: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function providerLaunchPlan(provider: ProviderId): ProviderLaunchAuthorityInput {
  const hex = (marker: string): string => marker.repeat(64)
  const common = {
    adapterRevision: 'provider-adapter-v1',
    model: `${provider}-scheduled-model`,
    modelCapabilitySha256: hex('1'),
    promptEnvelopeSha256: hex('2'),
    sessionMode: 'fresh' as const,
    resumeSessionHmac: null,
    providerSessionGenerationSha256: null,
    launchEnvironmentHmac: hex('3'),
    credentialStateHmac: hex('4'),
    providerConfigurationSha256: hex('5'),
    capabilityContractSha256: hex('6')
  }
  const tools = {
    taskWraithMcpAdvertised: true,
    taskWraithMcpProfileId: 'taskwraith-full-v1' as const,
    taskWraithMcpCatalogSha256: hex('7'),
    providerMcpConfigurationSha256: hex('8'),
    userMcpConfigurationSha256: hex('9'),
    nativeToolPolicySha256: hex('a'),
    brokerPolicySha256: hex('b')
  }
  const cli = {
    kind: 'cli' as const,
    executableRealPath: providerBinary(provider),
    executableSha256: hex('c'),
    runtimeBundleSha256: hex('d'),
    interpreterRuntimeAttestationSha256: hex('e'),
    executableVersion: '1.0.0',
    launchArgsTemplateSha256: hex('f')
  }
  switch (provider) {
    case 'codex':
      return {
        schemaVersion: 1,
        provider,
        common,
        runtime: cli,
        tools,
        controls: {
          transport: 'app-server',
          reasoningEffort: 'high',
          reasoningConfigurationSha256: hex('1'),
          serviceTier: 'fast',
          approvalPolicy: 'never',
          sandboxMode: 'read-only',
          sandboxPolicySha256: hex('2'),
          appServerConfigurationSha256: hex('3'),
          taskWraithMcpAttachmentMode: 'app-server-config',
          persistExtendedHistory: true,
          experimentalRawEvents: false,
          fallbackPolicy: 'forbid'
        }
      }
    case 'claude':
      return {
        schemaVersion: 1,
        provider,
        common,
        runtime: cli,
        tools,
        controls: {
          transport: 'agent-sdk',
          reasoningEffort: 'medium',
          thinkingConfigurationSha256: hex('1'),
          fastMode: false,
          permissionMode: 'default',
          sdkPackageSha256: hex('2'),
          builtinToolMode: 'disabled',
          includePartialMessages: true,
          taskWraithMcpAttachmentMode: 'sdk-config',
          imageTransport: 'sdk-images',
          fallbackPolicy: 'forbid'
        }
      }
    case 'kimi':
      return {
        schemaVersion: 1,
        provider,
        common,
        runtime: cli,
        tools,
        controls: {
          transport: 'wire',
          wireProtocolVersion: '1',
          serviceTier: 'standard',
          thinking: false,
          planMode: false,
          taskWraithMcpAttachmentMode: 'isolated-broker-only-file',
          agentFileSha256: hex('1'),
          sanitizerPolicySha256: hex('2'),
          contentFilterRetryPolicySha256: hex('3'),
          fallbackPolicy: 'forbid'
        }
      }
    case 'grok':
      return {
        schemaVersion: 1,
        provider,
        common,
        runtime: cli,
        tools,
        controls: {
          transport: 'acp',
          reasoningEffort: 'high',
          permissionMode: 'host-gated',
          readOnlySeat: true,
          taskWraithMcpAttachmentMode: 'acp-session',
          persistentSeatMode: 'fresh',
          webSearchEnabled: false,
          nativeDenyRulesSha256: hex('1'),
          promptPreambleSha256: hex('2'),
          fallbackPolicy: 'forbid'
        }
      }
    case 'cursor':
      return {
        schemaVersion: 1,
        provider,
        common,
        runtime: cli,
        tools,
        controls: {
          transport: 'cursor-agent-stream-json',
          reasoningEffort: 'medium',
          fastMode: false,
          executionMode: 'contained-default',
          bridgeMode: 'safe-subset',
          brokerRegistration: 'workspace',
          forceMcpTools: true,
          approveMcpServers: true,
          nativeContainmentConfigurationSha256: hex('1'),
          fallbackPolicy: 'forbid'
        }
      }
    case 'ollama':
      return {
        schemaVersion: 1,
        provider,
        common,
        runtime: {
          kind: 'http',
          endpointHmac: hex('1'),
          serverIdentitySha256: hex('2'),
          modelManifestSha256: hex('3')
        },
        tools,
        controls: {
          transport: 'http-chat',
          reasoningLevel: 'medium',
          contextCapTokens: 32_768,
          protocolMode: 'native_first',
          compactToolSchemas: false,
          oneToolAtATime: true,
          numPredictTool: 1024,
          numPredictFinal: 2048,
          keepAlive: '5m',
          temperature: 0,
          toolProtocolEnabled: true,
          nativeToolsSupported: true,
          readOnly: true,
          networkAccess: 'deny',
          harnessEnabled: true,
          maxConsecutiveNonProductiveTurns: 2,
          retryPolicySha256: hex('4'),
          memorySnapshotSha256: hex('5')
        }
      }
    case 'gemini':
      return { ...providerLaunchPlan('codex'), provider: 'gemini' } as never
  }
}

function contradictoryPosturePlan(provider: Exclude<ProviderId, 'gemini'>): ProviderLaunchAuthorityInput {
  const plan = providerLaunchPlan(provider)
  switch (provider) {
    case 'codex':
      return {
        ...plan,
        controls: { ...plan.controls, sandboxMode: 'workspace-write' }
      } as ProviderLaunchAuthorityInputByProvider['codex']
    case 'claude':
      return {
        ...plan,
        controls: { ...plan.controls, permissionMode: 'plan' }
      } as ProviderLaunchAuthorityInputByProvider['claude']
    case 'kimi':
      return {
        ...plan,
        controls: { ...plan.controls, planMode: true }
      } as ProviderLaunchAuthorityInputByProvider['kimi']
    case 'grok':
      return {
        ...plan,
        controls: { ...plan.controls, readOnlySeat: false }
      } as ProviderLaunchAuthorityInputByProvider['grok']
    case 'cursor':
      return {
        ...plan,
        controls: { ...plan.controls, executionMode: 'plan' }
      } as ProviderLaunchAuthorityInputByProvider['cursor']
    case 'ollama':
      return {
        ...plan,
        controls: { ...plan.controls, readOnly: false }
      } as ProviderLaunchAuthorityInputByProvider['ollama']
  }
}

function claudeCliReadOnlyPlan(): ProviderLaunchAuthorityInputByProvider['claude'] {
  const plan = providerLaunchPlan('claude') as ProviderLaunchAuthorityInputByProvider['claude']
  return {
    ...plan,
    controls: {
      ...plan.controls,
      transport: 'cli-print',
      permissionMode: 'plan',
      sdkPackageSha256: null,
      taskWraithMcpAttachmentMode: 'temp-cli-config',
      imageTransport: 'cli-image-args'
    }
  }
}

function kimiCliReadOnlyPlan(): ProviderLaunchAuthorityInputByProvider['kimi'] {
  const plan = providerLaunchPlan('kimi') as ProviderLaunchAuthorityInputByProvider['kimi']
  return {
    ...plan,
    controls: {
      ...plan.controls,
      transport: 'cli-print',
      wireProtocolVersion: null,
      planMode: true
    }
  }
}

function codexLaunchPlan(
  controls: Partial<ProviderLaunchAuthorityInputByProvider['codex']['controls']>,
  options: { advertiseTaskWraithMcp?: boolean } = {}
): ProviderLaunchAuthorityInputByProvider['codex'] {
  const plan = providerLaunchPlan('codex') as ProviderLaunchAuthorityInputByProvider['codex']
  const advertiseTaskWraithMcp = options.advertiseTaskWraithMcp !== false
  return {
    ...plan,
    tools: {
      ...plan.tools,
      taskWraithMcpAdvertised: advertiseTaskWraithMcp,
      taskWraithMcpProfileId: advertiseTaskWraithMcp ? 'taskwraith-full-v1' : null
    },
    controls: {
      ...plan.controls,
      ...controls,
      taskWraithMcpAttachmentMode: advertiseTaskWraithMcp
        ? 'app-server-config'
        : 'none'
    }
  }
}

function grokStreamingReadOnlyPlan(
  webSearchEnabled = false
): ProviderLaunchAuthorityInputByProvider['grok'] {
  const plan = providerLaunchPlan('grok') as ProviderLaunchAuthorityInputByProvider['grok']
  return {
    ...plan,
    tools: {
      ...plan.tools,
      taskWraithMcpAdvertised: false,
      taskWraithMcpProfileId: null
    },
    controls: {
      ...plan.controls,
      transport: 'streaming-json',
      permissionMode: 'plan',
      taskWraithMcpAttachmentMode: 'none',
      webSearchEnabled
    }
  }
}

function cursorBridgePlan(
  bridgeMode: ProviderLaunchAuthorityInputByProvider['cursor']['controls']['bridgeMode'],
  executionMode: ProviderLaunchAuthorityInputByProvider['cursor']['controls']['executionMode'] =
    bridgeMode === 'none' ? 'plan' : 'contained-default'
): ProviderLaunchAuthorityInputByProvider['cursor'] {
  const plan = providerLaunchPlan('cursor') as ProviderLaunchAuthorityInputByProvider['cursor']
  const active = bridgeMode !== 'none'
  return {
    ...plan,
    tools: {
      ...plan.tools,
      taskWraithMcpAdvertised: active,
      taskWraithMcpProfileId: active ? 'taskwraith-full-v1' : null
    },
    controls: {
      ...plan.controls,
      executionMode,
      bridgeMode,
      brokerRegistration: active ? 'workspace' : 'none',
      forceMcpTools: active,
      approveMcpServers: active
    }
  }
}

function effectiveAuthority(
  provider: ProviderId = 'codex',
  overrides: Partial<EffectiveRuntimeLaunchAuthorityInput> = {}
): EffectiveRuntimeLaunchAuthorityInput {
  const permissions = effectivePermissions()
  return {
    schemaVersion: 1,
    provider,
    effectiveBinary:
      provider === 'ollama'
        ? SCHEDULED_OCCURRENCE_OLLAMA_EFFECTIVE_BINARY_SENTINEL
        : providerBinary(provider),
    effectiveWorkspaceMode: 'local',
    effectiveMcpProfileId: 'taskwraith-full-v1',
    effectiveApprovalMode: permissions.approvalMode,
    effectiveAgenticServices: permissions.agenticServices,
    effectiveNetworkPolicy: permissions.networkAccess,
    effectivePersistence: 'reusable',
    providerLaunchAuthority: providerLaunchPlan(provider),
    ...overrides
  }
}

function effectivePermissions(
  overrides: Partial<EffectiveRunPermissions> = {}
): EffectiveRunPermissions {
  return {
    presetId: 'read_only',
    approvalMode: 'plan',
    agenticServices: {
      shellCommands: 'deny',
      fileChanges: 'deny',
      externalPublish: 'deny',
      mcpTools: 'ask',
      subThreadDelegation: 'deny',
      canvasInteraction: 'deny',
      canvasEval: 'deny',
      crossThreadRead: 'deny',
      mediaEditing: 'deny',
      mediaRecording: 'deny'
    },
    networkAccess: 'deny',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: true,
    ...overrides
  }
}

function postureCapability(
  provider: ProviderId,
  seatId: string,
  runtimeProfileId?: string,
  options: {
    permissions?: EffectiveRunPermissions
    context?: Partial<RunPermissionPostureContext>
    rootId?: string
    workspaceId?: string
    workspaceRealPath?: string
    secret?: Buffer
  } = {}
): ScheduledOccurrencePostureCapability {
  const permissions = options.permissions ?? effectivePermissions()
  const context: RunPermissionPostureContext = {
    provider,
    scope: 'workspace',
    appRunId: 'scheduled-1',
    appChatId: 'chat-1',
    prompt: 'Review the workspace.',
    workflowMode: 'normal',
    runtimeProfileId: runtimeProfileId ?? null,
    ensembleParticipantId:
      seatId !== 'root' && seatId !== SCHEDULED_LOOP_VERIFIER_SEAT_ID ? seatId : null,
    ensembleLaneId: null,
    ...options.context
  }
  const signature = signRunPermissionPosture(
    options.secret ?? POSTURE_SECRET,
    permissions.approvalMode,
    permissions,
    context
  )
  const input: ScheduledOccurrencePostureIssueInput = {
    rootId: options.rootId ?? ROOT.rootId,
    workspaceId: options.workspaceId ?? 'workspace-1',
    workspaceRealPath: options.workspaceRealPath ?? REAL_WORKSPACE_PATH,
    approvalMode: permissions.approvalMode,
    effectivePermissions: permissions,
    signature,
    context
  }
  const capability = POSTURE_VERIFIER.issue(input)
  if (!capability) throw new Error('Test posture capability was not issued.')
  POSTURE_INPUT_BY_CAPABILITY.set(capability as object, input)
  return capability
}

function selectedSeat(
  selectedProfile: RuntimeProfile = profile(),
  options: {
    seatId?: string
    resolvedEnv?: Record<string, string>
    effective?: EffectiveRuntimeLaunchAuthorityInput
    permissionCapability?: ScheduledOccurrencePostureCapability
  } = {}
): ScheduledOccurrenceRuntimeSeatContext {
  const seatId = options.seatId ?? 'root'
  return {
    seatId,
    launchAuthority: {
      kind: 'selected-runtime-profile',
      profile: selectedProfile,
      effectiveAuthority:
        options.effective ?? effectiveAuthority(selectedProfile.provider)
    },
    resolvedEnv: options.resolvedEnv ?? {
      PUBLIC_MODE: 'review',
      SERVICE_TOKEN: 'resolved-secret-token'
    },
    permissionPostureCapability:
      options.permissionCapability ??
      postureCapability(selectedProfile.provider, seatId, selectedProfile.id)
  }
}

function defaultSeat(
  provider: ProviderId,
  options: {
    seatId?: string
    resolvedEnv?: Record<string, string>
    effective?: EffectiveRuntimeLaunchAuthorityInput
    permissionCapability?: ScheduledOccurrencePostureCapability
  } = {}
): ScheduledOccurrenceRuntimeSeatContext {
  const seatId = options.seatId ?? 'root'
  return {
    seatId,
    launchAuthority: {
      kind: 'default-runtime',
      effectiveAuthority: options.effective ?? effectiveAuthority(provider)
    },
    resolvedEnv: options.resolvedEnv ?? { SERVICE_TOKEN: 'resolved-default-secret' },
    permissionPostureCapability:
      options.permissionCapability ?? postureCapability(provider, seatId)
  }
}

function defaultSeatForPermissions(
  provider: Exclude<ProviderId, 'gemini'>,
  permissions: EffectiveRunPermissions,
  providerLaunchAuthority: ProviderLaunchAuthorityInput
): ScheduledOccurrenceRuntimeSeatContext {
  return defaultSeat(provider, {
    effective: effectiveAuthority(provider, {
      effectiveMcpProfileId: providerLaunchAuthority.tools.taskWraithMcpProfileId,
      effectiveApprovalMode: permissions.approvalMode,
      effectiveAgenticServices: permissions.agenticServices,
      effectiveNetworkPolicy: permissions.networkAccess,
      providerLaunchAuthority
    }),
    permissionCapability: postureCapability(provider, 'root', undefined, {
      permissions
    })
  })
}

function context(
  scheduledTask: ScheduledTask = task(),
  overrides: Partial<ScheduledOccurrenceCurrentContext> = {}
): ScheduledOccurrenceCurrentContext {
  const phase = overrides.phase ?? { kind: 'running' as const, ownerRunId: OWNER_RUN_ID }
  const currentTask =
    phase.kind === 'running' &&
    (scheduledTask.status !== 'running' || scheduledTask.runId !== phase.ownerRunId)
      ? runningTask(scheduledTask, phase.ownerRunId)
      : scheduledTask
  const requestedWorkflow = overrides.workflow === undefined ? null : overrides.workflow
  const workflow =
    phase.kind === 'running' &&
    requestedWorkflow?.history.some(
      (execution) =>
        execution.id === requestedWorkflow.activeExecutionId &&
        execution.status === 'queued' &&
        execution.runId === undefined
    )
      ? runningWorkflow(requestedWorkflow, phase.ownerRunId)
      : requestedWorkflow
  const effectiveLoopVerifierProvider =
    overrides.effectiveLoopVerifierProvider !== undefined
      ? overrides.effectiveLoopVerifierProvider
      : workflow?.loop?.acceptance.verifier
        ? workflow.loop.acceptance.verifier.provider ?? currentTask.provider
        : null
  return {
    ...overrides,
    task: currentTask,
    workflow,
    canonicalizePath: canonicalPath,
    workspaceRealPath: REAL_WORKSPACE_PATH,
    runtimeSeats:
      overrides.runtimeSeats ?? defaultRuntimeSeats(currentTask, workflow),
    phase,
    effectiveLoopVerifierProvider
  }
}

function defaultRuntimeSeats(
  scheduledTask: ScheduledTask,
  workflow: WorkflowDefinition | null
): ScheduledOccurrenceRuntimeSeatContext[] {
  if (scheduledTask.kind === 'ensemble') {
    return (scheduledTask.ensembleSnapshot?.participants ?? [])
      .filter((participant) => participant.enabled)
      .map((participant) =>
        participant.runtimeProfileId
          ? selectedSeat(
              profile({
                id: participant.runtimeProfileId,
                provider: participant.provider,
                binaryPath: providerBinary(participant.provider)
              }),
              { seatId: participant.id }
            )
          : defaultSeat(participant.provider, { seatId: participant.id })
      )
  }
  const root = scheduledTask.runtimeProfileId
    ? selectedSeat(
        profile({
          id: scheduledTask.runtimeProfileId,
          provider: scheduledTask.provider,
          binaryPath: providerBinary(scheduledTask.provider)
        })
      )
    : defaultSeat(scheduledTask.provider)
  const verifierProvider = workflow?.loop?.acceptance.verifier?.provider
  return verifierProvider && verifierProvider !== scheduledTask.provider
    ? [
        root,
        defaultSeat(verifierProvider, { seatId: SCHEDULED_LOOP_VERIFIER_SEAT_ID })
      ]
    : [root]
}

function linkedTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return task({
    workflowId: 'workflow-1',
    workflowExecutionId: 'execution-1',
    workflowOccurrenceAt: plannedFor,
    ...overrides
  })
}

function workflowFor(
  scheduledTask: ScheduledTask,
  overrides: Partial<WorkflowDefinition> = {}
): WorkflowDefinition {
  return {
    id: 'workflow-1',
    name: 'Scheduled review',
    workspaceId: scheduledTask.workspaceId,
    workspacePath: scheduledTask.workspacePath,
    enabled: true,
    trigger: { kind: 'once', runAt: plannedFor, timezone: 'Europe/London' },
    template: scheduledTask as unknown as WorkflowRunTemplate,
    missedRunPolicy: 'coalesce',
    concurrencyPolicy: 'skip',
    limits: { maxRunsPerDay: 2, maxConsecutiveFailures: 2 },
    failureStreak: 0,
    activeExecutionId: 'execution-1',
    history: [
      {
        id: 'execution-1',
        workflowId: 'workflow-1',
        scheduledTaskId: scheduledTask.id,
        plannedFor: scheduledTask.workflowOccurrenceAt ?? plannedFor,
        status: 'queued',
        createdAt: now,
        updatedAt: now
      }
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function runningTask(current: ScheduledTask, ownerRunId = 'run-owner'): ScheduledTask {
  return {
    ...current,
    status: 'running',
    runId: ownerRunId,
    firedAt: now,
    runningSince: now,
    updatedAt: now
  }
}

function runningWorkflow(
  current: WorkflowDefinition,
  ownerRunId = 'run-owner'
): WorkflowDefinition {
  return {
    ...current,
    lastStatus: 'running',
    lastError: undefined,
    updatedAt: now,
    history: current.history.map((execution) =>
      execution.id === current.activeExecutionId
        ? {
            ...execution,
            status: 'running',
            runId: ownerRunId,
            startedAt: now,
            updatedAt: now
          }
        : execution
    )
  }
}

function mint(current: ScheduledOccurrenceCurrentContext = context()): ScheduledOccurrenceSealV2 {
  const seal = mintScheduledOccurrenceSeal(ROOT, current, now)
  current.task.occurrenceSeal = seal
  return seal
}

function persistSeal(
  current: ScheduledOccurrenceCurrentContext,
  seal: ScheduledOccurrenceSealV2
): ScheduledOccurrenceCurrentContext {
  current.task.occurrenceSeal = seal
  return current
}

function remac(
  seal: ScheduledOccurrenceSealV2,
  patch: Partial<ScheduledOccurrenceSealV2>,
  authorityRoot: ScheduledOccurrenceAuthorityRoot = ROOT
): ScheduledOccurrenceSealV2 {
  const candidate = { ...seal, ...patch }
  const { sealMac: _sealMac, ...payload } = candidate
  const encoded = JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    )
  )
  return {
    ...candidate,
    sealMac: authorityRoot.sealPayloadMac(Buffer.from(encoded, 'utf8'))
  }
}

function legacySealV1(seal: ScheduledOccurrenceSealV2): ScheduledOccurrenceSealV1 {
  return {
    schemaVersion: 1,
    issuedAt: seal.issuedAt,
    taskAuthorityDigest: seal.taskAuthorityDigest,
    compositeWorkflowAuthorityDigest: seal.compositeWorkflowAuthorityDigest,
    workspaceRealPath: seal.workspaceRealPath,
    runtimeProfileSetHmac: seal.runtimeProfileSetHmac,
    permissionPostureSetHmac: seal.permissionPostureSetHmac,
    sealSignature: 'a'.repeat(64)
  }
}

describe('ScheduledOccurrenceSeal lifecycle and posture authority', () => {
  it('mints and verifies an exact running post-image without persisting resolved secrets', () => {
    const current = context()
    const seal = mint(current)
    const persisted = structuredClone(seal)
    const verified = verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, persisted, current)

    expect(verified).toEqual(seal)
    expect(verified).not.toBe(persisted)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(JSON.stringify(seal)).not.toContain('resolved-secret-token')
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        testAuthorityRoot(Buffer.alloc(32, 20), '2'),
        seal,
        current
      )
    ).toBeNull()
    expect(seal).toMatchObject({
      schemaVersion: 2,
      rootId: ROOT.rootId,
      ownerRunId: OWNER_RUN_ID,
      rootOwner: 'solo'
    })
  })

  it('rejects queued minting and binds final verification to the exact running owner', () => {
    const running = context()
    const seal = mint(running)
    expect(verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, running)).not.toBeNull()
    const swappedOwner = context(runningTask(task(), 'other-owner'), {
      phase: { kind: 'running', ownerRunId: 'other-owner' }
    })
    persistSeal(swappedOwner, seal)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, swappedOwner)
    ).toBeNull()
    const queued = context(task(), { phase: { kind: 'queued' } })
    expect(() => mint(queued)).toThrow(/running post-image/i)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, queued)
    ).toBeNull()
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        KEY,
        seal,
        {
          ...running,
          task: { ...running.task, status: 'completed' }
        }
      )
    ).toBeNull()
    const changedPromptTask = task({ prompt: 'Mutated after ownership.' })
    const changedPrompt = context(changedPromptTask, {
      runtimeSeats: [
        selectedSeat(profile(), {
          permissionCapability: postureCapability('codex', 'root', 'profile-codex', {
            context: { prompt: changedPromptTask.prompt }
          })
        })
      ]
    })
    persistSeal(changedPrompt, seal)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, changedPrompt)
    ).toBeNull()
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, {
        ...running,
        workspaceRealPath: OTHER_REAL_PATH
      })
    ).toBeNull()
  })

  it('requires the exact claim post-image at mint and bounded running heartbeats at verify', () => {
    const mintVariants: Array<[string, Partial<ScheduledTask>]> = [
      ['firedAt', { firedAt: '2026-07-14T12:00:01.000Z' }],
      ['runningSince', { runningSince: '2026-07-14T12:00:01.000Z' }],
      ['updatedAt', { updatedAt: '2026-07-14T12:00:01.000Z' }],
      ['completedAt', { completedAt: now }],
      ['lastError', { lastError: 'terminal' }]
    ]
    for (const [field, patch] of mintVariants) {
      const candidate = context()
      Object.assign(candidate.task, patch)
      expect(() => mintScheduledOccurrenceSeal(ROOT, candidate, now), field).toThrow()
    }
    const whitespaceOwner = context(runningTask(task(), ' run-owner '), {
      phase: { kind: 'running', ownerRunId: ' run-owner ' }
    })
    expect(() => mintScheduledOccurrenceSeal(ROOT, whitespaceOwner, now)).toThrow(/trimmed/i)

    const current = context()
    const seal = mint(current)
    const heartbeatAt = '2026-07-14T12:05:00.000Z'
    const heartbeat = {
      ...current,
      task: {
        ...current.task,
        runningSince: heartbeatAt,
        updatedAt: heartbeatAt,
        occurrenceSeal: seal
      }
    }
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(ROOT, seal, heartbeat)
    ).not.toBeNull()
    for (const patch of [
      { firedAt: heartbeatAt },
      { runningSince: '2026-07-14T11:59:59.000Z' },
      { updatedAt: '2026-07-14T11:59:59.000Z' },
      { completedAt: heartbeatAt },
      { lastError: 'terminal' }
    ]) {
      expect(
        verifyScheduledOccurrenceSealAgainstCurrentContext(ROOT, seal, {
          ...heartbeat,
          task: { ...heartbeat.task, ...patch, occurrenceSeal: seal }
        })
      ).toBeNull()
    }

    const linked = linkedTask()
    const workflow = workflowFor(linked)
    const linkedCurrent = context(linked, { workflow })
    const linkedSeal = mint(linkedCurrent)
    const linkedHeartbeat = {
      ...linkedCurrent,
      task: {
        ...linkedCurrent.task,
        runningSince: heartbeatAt,
        updatedAt: heartbeatAt,
        occurrenceSeal: linkedSeal
      },
      workflow: {
        ...linkedCurrent.workflow!,
        updatedAt: heartbeatAt,
        history: linkedCurrent.workflow!.history.map((execution) =>
          execution.id === linkedCurrent.workflow!.activeExecutionId
            ? { ...execution, updatedAt: heartbeatAt }
            : execution
        )
      }
    }
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        ROOT,
        linkedSeal,
        linkedHeartbeat
      )
    ).not.toBeNull()
    for (const executionPatch of [
      { startedAt: heartbeatAt },
      { updatedAt: '2026-07-14T11:59:59.000Z' },
      { completedAt: heartbeatAt },
      { error: 'terminal' }
    ]) {
      expect(
        verifyScheduledOccurrenceSealAgainstCurrentContext(ROOT, linkedSeal, {
          ...linkedHeartbeat,
          workflow: {
            ...linkedHeartbeat.workflow,
            history: linkedHeartbeat.workflow.history.map((execution) =>
              execution.id === linkedHeartbeat.workflow.activeExecutionId
                ? { ...execution, ...executionPatch }
                : execution
            )
          }
        })
      ).toBeNull()
    }
    for (const workflowPatch of [
      { updatedAt: '2026-07-14T11:59:59.000Z' },
      { lastStatus: 'completed' as const },
      { lastError: 'terminal' }
    ]) {
      expect(
        verifyScheduledOccurrenceSealAgainstCurrentContext(ROOT, linkedSeal, {
          ...linkedHeartbeat,
          workflow: { ...linkedHeartbeat.workflow, ...workflowPatch }
        })
      ).toBeNull()
    }
  })

  it('requires a linked workflow to remain enabled at mint and verify', () => {
    const disabledTask = linkedTask()
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(disabledTask, {
          workflow: workflowFor(disabledTask, { enabled: false })
        }),
        now
      )
    ).toThrow(/enabled workflow/i)

    const linked = linkedTask()
    const current = context(linked, { workflow: workflowFor(linked) })
    const seal = mint(current)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(ROOT, seal, {
        ...current,
        workflow: { ...current.workflow!, enabled: false }
      })
    ).toBeNull()
  })

  it('requires the candidate seal to be the exact seal persisted on the task', () => {
    const current = context()
    const seal = mint(current)
    const missing = { ...current, task: { ...current.task, occurrenceSeal: undefined } }
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(ROOT, seal, missing)
    ).toBeNull()
    const different = remac(seal, { issuedAt: '2026-07-14T12:00:01.000Z' })
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(ROOT, seal, {
        ...current,
        task: { ...current.task, occurrenceSeal: different }
      })
    ).toBeNull()
  })

  it('requires exact linked execution and workflow running projections', () => {
    const candidate = (): ScheduledOccurrenceCurrentContext => {
      const linked = linkedTask()
      return context(linked, { workflow: workflowFor(linked) })
    }
    const withExecutionPatch = (
      current: ScheduledOccurrenceCurrentContext,
      patch: Record<string, unknown>
    ): ScheduledOccurrenceCurrentContext => ({
      ...current,
      workflow: {
        ...current.workflow!,
        history: current.workflow!.history.map((execution) =>
          execution.id === current.workflow!.activeExecutionId
            ? { ...execution, ...patch }
            : execution
        )
      }
    })

    for (const patch of [
      { startedAt: '2026-07-14T12:00:01.000Z' },
      { updatedAt: '2026-07-14T12:00:01.000Z' },
      { completedAt: now },
      { error: 'terminal' }
    ]) {
      const current = candidate()
      expect(() =>
        mintScheduledOccurrenceSeal(ROOT, withExecutionPatch(current, patch), now)
      ).toThrow(
        /running post-image|claim timestamps/i
      )
    }
    for (const patch of [
      { updatedAt: '2026-07-14T12:00:01.000Z' },
      { lastStatus: 'completed' as const },
      { lastError: 'terminal' }
    ]) {
      const current = candidate()
      expect(() =>
        mintScheduledOccurrenceSeal(
          ROOT,
          { ...current, workflow: { ...current.workflow!, ...patch } },
          now
        )
      ).toThrow(
        /running post-image|claim timestamps/i
      )
    }
  })

  it('rejects root, owner, and derived-root-owner swaps independently of MAC validity', () => {
    const current = context()
    const seal = mint(current)
    const ownerCandidate = remac(seal, { ownerRunId: 'other-owner' })
    const ownerCandidateContext = {
      ...current,
      task: { ...current.task, occurrenceSeal: ownerCandidate }
    }

    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        ROOT,
        ownerCandidate,
        ownerCandidateContext
      )
    ).toBeNull()
    const rootOwnerCandidate = remac(seal, { rootOwner: 'ensemble-root' })
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        ROOT,
        rootOwnerCandidate,
        { ...current, task: { ...current.task, occurrenceSeal: rootOwnerCandidate } }
      )
    ).toBeNull()
    const rootCandidate = remac(seal, {
      rootId: `twso-root-v1:${'2'.repeat(64)}`
    })
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        ROOT,
        rootCandidate,
        { ...current, task: { ...current.task, occurrenceSeal: rootCandidate } }
      )
    ).toBeNull()

    const replacementRoot = testAuthorityRoot(Buffer.alloc(32, 27), '2')
    const replacementContext = context(task(), {
      runtimeSeats: [
        selectedSeat(profile(), {
          permissionCapability: postureCapability('codex', 'root', 'profile-codex', {
            rootId: replacementRoot.rootId
          })
        })
      ]
    })
    const replacementSeal = mintScheduledOccurrenceSeal(
      replacementRoot,
      replacementContext,
      now
    )
    persistSeal(replacementContext, replacementSeal)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        ROOT,
        replacementSeal,
        replacementContext
      )
    ).toBeNull()
    const sameIdDifferentSecret = testAuthorityRoot(Buffer.alloc(32, 28), '1')
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        sameIdDifferentSecret,
        seal,
        current
      )
    ).toBeNull()
  })

  it('fails closed after the authority-root capability is disposed', () => {
    const authorityRoot = testAuthorityRoot(Buffer.alloc(32, 29), '3')
    const current = context(task(), {
      runtimeSeats: [
        selectedSeat(profile(), {
          permissionCapability: postureCapability('codex', 'root', 'profile-codex', {
            rootId: authorityRoot.rootId
          })
        })
      ]
    })
    const seal = mintScheduledOccurrenceSeal(authorityRoot, current, now)
    const secondCurrent = context(task(), {
      runtimeSeats: [
        selectedSeat(profile(), {
          permissionCapability: postureCapability('codex', 'root', 'profile-codex', {
            rootId: authorityRoot.rootId
          })
        })
      ]
    })
    persistSeal(current, seal)
    authorityRoot.dispose()

    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(authorityRoot, seal, current)
    ).toBeNull()
    expect(() => mintScheduledOccurrenceSeal(authorityRoot, secondCurrent, now)).toThrow(
      /disposed/i
    )
  })

  it('derives root identity and ownership internally rather than from caller fields', () => {
    const injected = {
      ...context(),
      rootId: `twso-root-v1:${'f'.repeat(64)}`,
      rootOwner: 'ensemble-root'
    } as ScheduledOccurrenceCurrentContext
    const seal = mint(injected)

    expect(seal.rootId).toBe(ROOT.rootId)
    expect(seal.rootOwner).toBe('solo')
  })

  it('uses opaque, fully signed per-seat posture authority instead of persisted snapshots', () => {
    const current = context()
    const seal = mint(current)
    const changedPersistedPosture = task({
      permissionPosture: { projectionOnly: true } as never
    })
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        KEY,
        seal,
        persistSeal(context(changedPersistedPosture), seal)
      )
    ).not.toBeNull()

    const changedPermissions = effectivePermissions({
      networkAccess: 'allow',
      externalPathGrants: [
        {
          id: 'external-1',
          provider: 'codex',
          bindingVersion: 2,
          workspaceId: 'workspace-1',
          chatId: 'chat-1',
          appRunId: 'scheduled-1',
          path: EXTERNAL_GRANT_PATH,
          kind: 'directory',
          access: 'read',
          duration: 'thisRun',
          issuedBy: 'main',
          signature: 'f'.repeat(64),
          createdAt: now
        }
      ]
    })
    const changedFreshPosture = context(current.task, {
      runtimeSeats: [
        selectedSeat(profile(), {
          permissionCapability: postureCapability('codex', 'root', 'profile-codex', {
            permissions: changedPermissions
          })
        })
      ]
    })
    persistSeal(changedFreshPosture, seal)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, changedFreshPosture)
    ).toBeNull()

    const forgedContext: RunPermissionPostureContext = {
      provider: 'codex',
      scope: 'workspace',
      appRunId: 'scheduled-1',
      appChatId: 'chat-1',
      prompt: 'Review the workspace.',
      workflowMode: 'normal',
      runtimeProfileId: 'profile-codex',
      ensembleParticipantId: null,
      ensembleLaneId: null
    }
    const permissions = effectivePermissions()
    const forgedCapability = POSTURE_VERIFIER.issue({
      rootId: ROOT.rootId,
      workspaceId: 'workspace-1',
      workspaceRealPath: REAL_WORKSPACE_PATH,
      approvalMode: permissions.approvalMode,
      effectivePermissions: permissions,
      signature: signRunPermissionPosture(
        Buffer.alloc(32, 99),
        permissions.approvalMode,
        permissions,
        forgedContext
      ),
      context: forgedContext
    })
    expect(forgedCapability).toBeNull()
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(task(), {
          runtimeSeats: [
            selectedSeat(profile(), {
              permissionCapability: Object.freeze({}) as ScheduledOccurrencePostureCapability
            })
          ]
        }),
        now
      )
    ).toThrow(/fresh verified permission posture capability/i)
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(task(), {
          runtimeSeats: [
            selectedSeat(profile(), {
              permissionCapability: postureCapability('claude', 'root', 'profile-codex')
            })
          ]
        }),
        now
      )
    ).toThrow(/provider does not match/i)

    const contextMismatches: Array<Partial<RunPermissionPostureContext>> = [
      { scope: 'global' },
      { appRunId: 'other-occurrence' },
      { appChatId: 'other-chat' },
      { prompt: 'Changed prompt.' },
      { workflowMode: 'plan' },
      { runtimeProfileId: 'other-profile' },
      { ensembleParticipantId: 'smuggled-participant' },
      { ensembleLaneId: 'smuggled-lane' }
    ]
    for (const contextPatch of contextMismatches) {
      expect(() =>
        mintScheduledOccurrenceSeal(
          ROOT,
          context(task(), {
            runtimeSeats: [
              selectedSeat(profile(), {
                permissionCapability: postureCapability(
                  'codex',
                  'root',
                  'profile-codex',
                  { context: contextPatch }
                )
              })
            ]
          }),
          now
        )
      ).toThrow(/posture (context|participant|lane|cannot claim)|capability was not issued/i)
    }
    for (const bindingPatch of [
      { workspaceId: 'other-workspace' },
      { workspaceRealPath: OTHER_REAL_PATH },
      { rootId: `twso-root-v1:${'9'.repeat(64)}` }
    ]) {
      expect(() =>
        mintScheduledOccurrenceSeal(
          ROOT,
          context(task(), {
            runtimeSeats: [
              selectedSeat(profile(), {
                permissionCapability: postureCapability(
                  'codex',
                  'root',
                  'profile-codex',
                  bindingPatch
                )
              })
            ]
          }),
          now
        )
      ).toThrow(/root or workspace/i)
    }
  })

  it('requires a fresh capability from the explicitly supplied verifier instance', () => {
    const current = context()
    const seat = current.runtimeSeats[0]
    const input = POSTURE_INPUT_BY_CAPABILITY.get(
      seat.permissionPostureCapability as object
    )!
    const foreignVerifier = createScheduledOccurrencePostureVerifier(POSTURE_SECRET)
    const foreignCapability = foreignVerifier.issue(input)!
    const foreignContext = {
      ...current,
      runtimeSeats: [
        { ...seat, permissionPostureCapability: foreignCapability }
      ]
    }
    expect(() =>
      mintScheduledOccurrenceSealWithPostureResolver(
        ROOT,
        POSTURE_VERIFIER.resolver,
        foreignContext,
        now
      )
    ).toThrow(/fresh verified permission posture capability/i)

    expect(
      mintScheduledOccurrenceSealWithPostureResolver(
        ROOT,
        POSTURE_VERIFIER.resolver,
        current,
        now
      )
    ).toMatchObject({ schemaVersion: 2 })
    expect(() =>
      mintScheduledOccurrenceSealWithPostureResolver(
        ROOT,
        POSTURE_VERIFIER.resolver,
        current,
        now
      )
    ).toThrow(/fresh verified permission posture capability/i)
  })
})

describe('task and workflow production-shape authority', () => {
  it('binds runnable task fields while excluding lifecycle and persisted posture projection', () => {
    const base = task()
    const expected = scheduledTaskAuthorityDigest(base, canonicalPath)
    const variants: Array<[string, ScheduledTask]> = [
      ['id', { ...base, id: 'scheduled-2' }],
      ['workspace', { ...base, workspacePath: '/other' }],
      ['chat', { ...base, chatId: 'chat-2' }],
      ['provider', { ...base, provider: 'claude' }],
      ['prompt', { ...base, prompt: 'Different prompt.' }],
      ['model', { ...base, selectedModelType: 'gpt-5.6-sol' }],
      ['approval', { ...base, approvalMode: 'auto_edit' }],
      ['profile', { ...base, runtimeProfileId: 'profile-other' }],
      ['runAt', { ...base, runAt: '2026-07-14T14:00:00.000Z' }],
      ['timezone', { ...base, timezone: 'America/New_York' }],
      [
        'attachment',
        {
          ...base,
          imageAttachments: base.imageAttachments.map((attachment) => ({
            ...attachment,
            sha256: '9'.repeat(64)
          }))
        }
      ],
      [
        'grant',
        {
          ...base,
          externalPathGrants: base.externalPathGrants?.map((grant) => ({
            ...grant,
            access: 'read'
          }))
        }
      ]
    ]
    for (const [field, candidate] of variants) {
      expect(scheduledTaskAuthorityDigest(candidate, canonicalPath), field).not.toBe(expected)
    }

    expect(
      scheduledTaskAuthorityDigest(
        {
          ...base,
          status: 'completed',
          runId: 'run-2',
          firedAt: now,
          completedAt: now,
          permissionPosture: { projectionOnly: true } as never,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2027-01-01T00:00:00.000Z'
        },
        canonicalPath
      )
    ).toBe(expected)
  })

  it('accepts the real materializer shape where plannedFor differs from dispatch runAt', () => {
    const linked = linkedTask({ runAt })
    const workflow = workflowFor(linked)
    const running = context(linked, { workflow })
    const seal = mint(running)
    expect(linked.workflowOccurrenceAt).toBe(plannedFor)
    expect(linked.runAt).toBe(runAt)
    expect(verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, running)).not.toBeNull()
    const otherOwner = context(runningTask(linked, 'workflow-owner'), {
      workflow: runningWorkflow(workflow, 'workflow-owner'),
      phase: { kind: 'running', ownerRunId: 'workflow-owner' }
    })
    persistSeal(otherOwner, seal)
    expect(verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, otherOwner)).toBeNull()
  })

  it('requires exact workflow phase, owner, linkage and current template authority', () => {
    const linked = linkedTask()
    const workflow = workflowFor(linked)
    const running = context(linked, { workflow })
    const seal = mint(running)

    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(linked, {
          workflow: runningWorkflow(workflow),
          phase: { kind: 'queued' }
        }),
        now
      )
    ).toThrow(/running post-image/i)
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(linkedTask({ workflowId: undefined }), { workflow }),
        now
      )
    ).toThrow(/entirely present or entirely absent/i)
    expect(() =>
      mint(
        context(linked, {
          workflow: { ...workflow, activeExecutionId: 'execution-other' }
        })
      )
    ).toThrow(/identity is not current/i)
    expect(() =>
      mint(
        context(linked, {
          workflow: {
            ...workflow,
            template: { ...workflow.template, prompt: 'Changed.' }
          }
        })
      )
    ).toThrow(/no longer matches/i)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, {
        ...running,
        workflow: {
          ...running.workflow!,
          limits: { ...running.workflow!.limits, maxRunsPerDay: 3 }
        }
      })
    ).toBeNull()
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, {
        ...running,
        workflow: { ...running.workflow!, enabled: !running.workflow!.enabled }
      })
    ).toBeNull()
  })

  it('normalizes explicitly undefined typed optional nested fields as absence', () => {
    const participant = {
      id: 'boss',
      provider: 'codex' as const,
      enabled: true,
      role: 'Boss',
      instructions: 'Lead.',
      order: 1,
      model: undefined,
      runtimeProfileId: 'profile-codex'
    }
    const withUndefined = task({
      kind: 'ensemble',
      runtimeProfileId: undefined,
      ensembleSnapshot: {
        orchestrationMode: 'continuous',
        fanoutPolicy: undefined,
        participants: [participant],
        maxContinuationHops: undefined,
        capturedAt: now
      }
    })
    const withoutUndefined = structuredClone(withUndefined)
    delete withoutUndefined.ensembleSnapshot?.participants[0].model
    delete withoutUndefined.ensembleSnapshot?.fanoutPolicy
    delete withoutUndefined.ensembleSnapshot?.maxContinuationHops
    expect(scheduledTaskAuthorityDigest(withUndefined, canonicalPath)).toBe(
      scheduledTaskAuthorityDigest(withoutUndefined, canonicalPath)
    )

    const invalidArray = structuredClone(withoutUndefined)
    invalidArray.ensembleSnapshot!.participants = [undefined as never]
    expect(() => scheduledTaskAuthorityDigest(invalidArray, canonicalPath)).toThrow()
  })
})

describe('runtime launch and loop verifier authority', () => {
  it('derives solo, loop-root, and ensemble-root ownership and rejects mixed roots', () => {
    expect(mint(context()).rootOwner).toBe('solo')

    const loopTask = linkedTask()
    const loopWorkflow = workflowFor(loopTask, {
      loop: {
        acceptance: { maxIterations: 2, verifier: { provider: 'codex' } },
        limits: { maxRuns: 4 }
      }
    })
    expect(mint(context(loopTask, { workflow: loopWorkflow })).rootOwner).toBe('loop-root')

    const ensembleTask = task({
      runtimeProfileId: undefined,
      kind: 'ensemble',
      ensembleSnapshot: {
        orchestrationMode: 'turn_bound',
        participants: [
          {
            id: 'boss',
            provider: 'codex',
            enabled: true,
            role: 'Boss',
            instructions: 'Lead.',
            order: 1
          }
        ],
        capturedAt: now
      }
    })
    expect(mint(context(ensembleTask)).rootOwner).toBe('ensemble-root')

    const linkedEnsemble = {
      ...ensembleTask,
      workflowId: 'workflow-1',
      workflowExecutionId: 'execution-1',
      workflowOccurrenceAt: plannedFor
    }
    const contradictoryWorkflow = workflowFor(linkedEnsemble, {
      loop: {
        acceptance: { maxIterations: 2, verifier: { provider: 'codex' } },
        limits: { maxRuns: 4 }
      }
    })
    expect(() => mint(context(linkedEnsemble, { workflow: contradictoryWorkflow }))).toThrow(
      /Ensemble.*loop/i
    )
  })

  it('links profile classification to the emitted authority and binds provenance', () => {
    const original = buildRuntimeProfileAuthority(profile())
    const expectedFields = Object.entries(RUNTIME_PROFILE_AUTHORITY_FIELD_POLICY)
      .filter(([, policy]) => policy === 'authority')
      .map(([field]) => field)
      .sort()
    expect(Object.keys(original).filter((field) => field !== 'schemaVersion').sort()).toEqual(
      expectedFields
    )

    expect(
      buildRuntimeProfileAuthority(
        profile({
          name: 'Renamed profile',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2027-01-01T00:00:00.000Z'
        })
      )
    ).toEqual(original)
    expect(buildRuntimeProfileAuthority(profile({ builtin: true }))).not.toEqual(original)
    expect(
      buildRuntimeProfileAuthority(
        profile({
          pluginProvenance: {
            pluginId: 'plugin.demo',
            publisher: 'TaskWraith',
            version: '1.0.0',
            source: 'local',
            namespace: 'demo',
            manifestHash: 'manifest-1',
            kind: 'runtimeProfile',
            objectId: 'runtime.codex',
            materializedAt: now
          }
        })
      )
    ).not.toEqual(original)
    expect(() =>
      buildRuntimeProfileAuthority({ ...profile(), futureExecutionField: true } as never)
    ).toThrow(/invalid field set/i)
    const hostileEnv = JSON.parse('{"__proto__":"sealed-value"}') as Record<string, string>
    const hostileEnvAuthority = buildRuntimeProfileAuthority(profile({ env: hostileEnv }))
    expect(Object.prototype.hasOwnProperty.call(hostileEnvAuthority.env, '__proto__')).toBe(true)
    expect(hostileEnvAuthority.env.__proto__).toBe('sealed-value')
    expect(hostileEnvAuthority).not.toEqual(original)
    expect(Object.isFrozen(original)).toBe(true)
  })

  it('binds both selected profile configuration and freshly resolved effective launch authority', () => {
    const current = context()
    const expected = mintScheduledOccurrenceSeal(ROOT, current, now).runtimeProfileSetHmac
    const profileVariants: RuntimeProfile[] = [
      profile({ binaryPath: OTHER_CODEX_BINARY }),
      profile({ env: { PUBLIC_MODE: 'changed' } }),
      profile({ secretRefs: { env: ['OTHER_TOKEN'] } }),
      profile({ agenticServices: { fileChanges: 'deny' } }),
      profile({ networkPolicy: 'allow' })
    ]
    for (const candidate of profileVariants) {
      expect(
        mintScheduledOccurrenceSeal(
          ROOT,
          context(task(), { runtimeSeats: [selectedSeat(candidate)] }),
          now
        ).runtimeProfileSetHmac
      ).not.toBe(expected)
    }

    const effectiveVariants: Partial<EffectiveRuntimeLaunchAuthorityInput>[] = [
      {
        providerLaunchAuthority: {
          ...providerLaunchPlan('codex'),
          common: {
            ...providerLaunchPlan('codex').common,
            modelCapabilitySha256: '8'.repeat(64)
          }
        } as ProviderLaunchAuthorityInputByProvider['codex']
      }
    ]
    for (const override of effectiveVariants) {
      expect(
        mintScheduledOccurrenceSeal(
          ROOT,
          context(task(), {
            runtimeSeats: [
              selectedSeat(profile(), {
                effective: effectiveAuthority('codex', override)
              })
            ]
          }),
          now
        ).runtimeProfileSetHmac
      ).not.toBe(expected)
    }

    const selectedProfileContradictions: Array<
      [RuntimeProfile, Partial<EffectiveRuntimeLaunchAuthorityInput>]
    > = [
      [profile({ workspaceMode: 'worktree' }), {}],
      [profile({ mcpProfileId: 'taskwraith-core-v1' }), {}],
      [profile({ persistence: 'ephemeral' }), {}],
      [profile({ approvalMode: 'plan' }), { effectiveApprovalMode: 'default' }],
      [
        profile({ agenticServices: { fileChanges: 'deny' } }),
        {
          effectiveAgenticServices: {
            ...effectivePermissions().agenticServices,
            fileChanges: 'allow'
          }
        }
      ],
      [
        profile({
          agenticServices: { networkAccess: 'deny' },
          networkPolicy: 'deny'
        }),
        { effectiveNetworkPolicy: 'allow' }
      ]
    ]
    for (const [selectedProfile, effectiveOverride] of selectedProfileContradictions) {
      expect(() =>
        mintScheduledOccurrenceSeal(
          ROOT,
          context(task(), {
            runtimeSeats: [
              selectedSeat(selectedProfile, {
                effective: effectiveAuthority('codex', effectiveOverride)
              })
            ]
          }),
          now
        )
      ).toThrow(/selected runtime profile|more permissive/i)
    }

    for (const contradiction of [
      { effectiveBinary: OTHER_CODEX_BINARY },
      { effectiveMcpProfileId: 'taskwraith-core-v1' },
      { effectiveApprovalMode: 'default' },
      { effectiveNetworkPolicy: 'allow' }
    ] satisfies Partial<EffectiveRuntimeLaunchAuthorityInput>[]) {
      expect(() =>
        mintScheduledOccurrenceSeal(
          ROOT,
          context(task(), {
            runtimeSeats: [
              selectedSeat(profile(), {
                effective: effectiveAuthority('codex', contradiction)
              })
            ]
          }),
          now
        )
      ).toThrow(/does not match|more permissive/i)
    }
    const seal = mint(current)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        ROOT,
        seal,
        context(current.task, {
          runtimeSeats: [selectedSeat(profile({ binaryPath: OTHER_CODEX_BINARY }))]
        })
      )
    ).toBeNull()
  })

  it('normalizes optional selected-profile subobjects deliberately', () => {
    const base = profile({
      secretRefs: {},
      agenticServices: {},
      containerConfig: { image: undefined, workdir: undefined, mounts: undefined }
    })
    const explicitUndefined = profile({
      secretRefs: { env: undefined },
      agenticServices: { fileChanges: undefined, networkAccess: undefined },
      containerConfig: { image: undefined, workdir: undefined, mounts: undefined }
    })
    expect(buildRuntimeProfileAuthority(explicitUndefined)).toEqual(
      buildRuntimeProfileAuthority(base)
    )
  })

  it('requires a provider-bound exhaustive digest instead of arbitrary launch bags', () => {
    const built = buildEffectiveRuntimeLaunchAuthority(effectiveAuthority())
    expect(buildDefaultRuntimeLaunchAuthority(effectiveAuthority())).toEqual(built)
    expect(Object.isFrozen(built)).toBe(true)
    expect(built.providerLaunchAuthorityDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(built).not.toHaveProperty('providerLaunchAuthority')
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority(),
        providerLaunchAuthority: { transport: 'app-server' }
      } as never)
    ).toThrow(/invalid field set/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority(),
        providerLaunchAuthority: providerLaunchPlan('codex'),
        providerLaunchAuthorityDigest: 'not-a-digest'
      } as never)
    ).toThrow(/invalid field set/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority('codex'),
        providerLaunchAuthority: providerLaunchPlan('claude')
      })
    ).toThrow(/does not match/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority('codex'),
        effectiveBinary: OTHER_CODEX_BINARY
      })
    ).toThrow(/binary does not match/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority('codex'),
        effectiveMcpProfileId: 'taskwraith-core-v1'
      })
    ).toThrow(/MCP profile does not match/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority('codex'),
        effectiveNetworkPolicy: 'inherit'
      } as never)
    ).toThrow(/effective network policy is invalid/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority('codex'),
        effectiveWorkspaceMode: 'container'
      })
    ).toThrow(/effective workspace mode is invalid/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority('ollama'),
        effectiveBinary: providerBinary('ollama')
      })
    ).toThrow(/canonical HTTP runtime marker/i)
    const missingAgenticField = { ...effectiveAuthority().effectiveAgenticServices }
    delete (missingAgenticField as Partial<typeof missingAgenticField>).mediaRecording
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority(),
        effectiveAgenticServices: missingAgenticField as never
      })
    ).toThrow(/invalid field set/i)
  })

  it('rejects exact-wrapper smuggling, duplicate active executions, and launch/posture contradictions', () => {
    const extraSeat = selectedSeat() as ScheduledOccurrenceRuntimeSeatContext & {
      futureAuthority?: boolean
    }
    extraSeat.futureAuthority = true
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(task(), { runtimeSeats: [extraSeat] }),
        now
      )
    ).toThrow(/runtime seat.*invalid field set/i)

    const wrappedSeat = selectedSeat()
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(task(), {
          runtimeSeats: [
            {
              ...wrappedSeat,
              launchAuthority: {
                ...wrappedSeat.launchAuthority,
                futureAuthority: true
              } as never
            }
          ]
        }),
        now
      )
    ).toThrow(/launch authority.*invalid field set/i)

    const linked = linkedTask()
    const duplicateContext = context(linked, { workflow: workflowFor(linked) })
    duplicateContext.workflow!.history.push({
      ...duplicateContext.workflow!.history[0]
    })
    expect(() => mintScheduledOccurrenceSeal(ROOT, duplicateContext, now)).toThrow(
      /active execution identity must be unique/i
    )

    const contradictoryServices = {
      ...effectivePermissions().agenticServices,
      fileChanges: 'allow' as const
    }
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(task({ runtimeProfileId: undefined }), {
          runtimeSeats: [
            defaultSeat('codex', {
              effective: effectiveAuthority('codex', {
                effectiveAgenticServices: contradictoryServices
              })
            })
          ]
        }),
        now
      )
    ).toThrow(/agentic services do not match/i)

    for (const provider of [
      'codex',
      'claude',
      'kimi',
      'grok',
      'cursor',
      'ollama'
    ] as const) {
      const scheduled = task({
        provider,
        runtimeProfileId: undefined,
        selectedModelType: `${provider}-model`
      })
      expect(() =>
        mintScheduledOccurrenceSeal(
          ROOT,
          context(scheduled, {
            runtimeSeats: [
              defaultSeat(provider, {
                effective: effectiveAuthority(provider, {
                  providerLaunchAuthority: contradictoryPosturePlan(provider)
                })
              })
            ]
          }),
          now
        )
      ).toThrow(/do(?:es)? not match the signed posture/i)
    }
  })

  it('accepts the exact read-only transport controls used by each provider path', () => {
    const cases: Array<
      [Exclude<ProviderId, 'gemini' | 'grok' | 'cursor' | 'ollama'>, ProviderLaunchAuthorityInput]
    > = [
      ['codex', providerLaunchPlan('codex')],
      ['claude', providerLaunchPlan('claude')],
      ['claude', claudeCliReadOnlyPlan()],
      ['kimi', providerLaunchPlan('kimi')],
      ['kimi', kimiCliReadOnlyPlan()]
    ]
    for (const [provider, providerLaunchAuthority] of cases) {
      const scheduled = task({
        provider,
        runtimeProfileId: undefined,
        selectedModelType: `${provider}-model`
      })
      expect(
        mintScheduledOccurrenceSeal(
          ROOT,
          context(scheduled, {
            runtimeSeats: [
              defaultSeat(provider, {
                effective: effectiveAuthority(provider, { providerLaunchAuthority })
              })
            ]
          }),
          now
        )
      ).toMatchObject({ schemaVersion: 2 })
    }

    const streamingGrok = task({
      provider: 'grok',
      runtimeProfileId: undefined,
      selectedModelType: 'grok-model'
    })
    expect(
      mintScheduledOccurrenceSeal(
        ROOT,
        context(streamingGrok, {
          runtimeSeats: [
            defaultSeat('grok', {
              effective: effectiveAuthority('grok', {
                effectiveMcpProfileId: null,
                providerLaunchAuthority: grokStreamingReadOnlyPlan()
              })
            })
          ]
        }),
        now
      )
    ).toMatchObject({ schemaVersion: 2 })
  })

  it('reconciles Codex approval policy with exact signed services and transport', () => {
    const planPermissions = effectivePermissions()
    const defaultPermissions = effectivePermissions({
      presetId: 'default',
      approvalMode: 'default',
      readOnly: false
    })
    const autoEditAllowedPermissions = effectivePermissions({
      presetId: 'workspace_write',
      approvalMode: 'auto_edit',
      agenticServices: {
        ...effectivePermissions().agenticServices,
        shellCommands: 'allow',
        fileChanges: 'allow',
        mcpTools: 'allow'
      },
      readOnly: false
    })
    const autoEditGatedPermissions = effectivePermissions({
      presetId: 'workspace_write',
      approvalMode: 'auto_edit',
      readOnly: false
    })

    const accepted: Array<
      [EffectiveRunPermissions, ProviderLaunchAuthorityInputByProvider['codex']]
    > = [
      [planPermissions, codexLaunchPlan({ approvalPolicy: 'never' })],
      [
        defaultPermissions,
        codexLaunchPlan({ approvalPolicy: 'on-request', sandboxMode: 'workspace-write' })
      ],
      [
        autoEditAllowedPermissions,
        codexLaunchPlan({ approvalPolicy: 'never', sandboxMode: 'workspace-write' })
      ],
      [
        autoEditGatedPermissions,
        codexLaunchPlan({ approvalPolicy: 'on-request', sandboxMode: 'workspace-write' })
      ]
    ]
    for (const [permissions, launch] of accepted) {
      const scheduled = task({
        runtimeProfileId: undefined,
        approvalMode: permissions.approvalMode,
        permissionPresetId: permissions.presetId
      })
      expect(
        mintScheduledOccurrenceSeal(
          ROOT,
          context(scheduled, {
            runtimeSeats: [defaultSeatForPermissions('codex', permissions, launch)]
          }),
          now
        )
      ).toMatchObject({ schemaVersion: 2 })
    }

    const rejected: Array<
      [EffectiveRunPermissions, ProviderLaunchAuthorityInputByProvider['codex']]
    > = [
      [planPermissions, codexLaunchPlan({ approvalPolicy: 'on-request' })],
      [
        defaultPermissions,
        codexLaunchPlan({ approvalPolicy: 'never', sandboxMode: 'workspace-write' })
      ],
      [
        autoEditAllowedPermissions,
        codexLaunchPlan({ approvalPolicy: 'on-request', sandboxMode: 'workspace-write' })
      ],
      [
        autoEditGatedPermissions,
        codexLaunchPlan({ approvalPolicy: 'never', sandboxMode: 'workspace-write' })
      ]
    ]
    for (const [permissions, launch] of rejected) {
      const scheduled = task({
        runtimeProfileId: undefined,
        approvalMode: permissions.approvalMode,
        permissionPresetId: permissions.presetId
      })
      expect(() =>
        mintScheduledOccurrenceSeal(
          ROOT,
          context(scheduled, {
            runtimeSeats: [defaultSeatForPermissions('codex', permissions, launch)]
          }),
          now
        )
      ).toThrow(/approval policy does not match/i)
    }

    const interactiveExec = codexLaunchPlan(
      {
        transport: 'exec-json',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write'
      },
      { advertiseTaskWraithMcp: false }
    )
    const scheduled = task({
      runtimeProfileId: undefined,
      approvalMode: 'default',
      permissionPresetId: 'default'
    })
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(scheduled, {
          runtimeSeats: [
            defaultSeatForPermissions('codex', defaultPermissions, interactiveExec)
          ]
        }),
        now
      )
    ).toThrow(/exec transport cannot satisfy an interactive approval/i)
  })

  it('rejects provider-native bypasses, denied MCP advertisement, and Grok web search', () => {
    const claudePlan = providerLaunchPlan(
      'claude'
    ) as ProviderLaunchAuthorityInputByProvider['claude']
    const scheduledClaude = task({
      provider: 'claude',
      runtimeProfileId: undefined,
      selectedModelType: 'claude-model'
    })
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(scheduledClaude, {
          runtimeSeats: [
            defaultSeat('claude', {
              effective: effectiveAuthority('claude', {
                providerLaunchAuthority: {
                  ...claudePlan,
                  controls: { ...claudePlan.controls, builtinToolMode: 'provider-native' }
                }
              })
            })
          ]
        }),
        now
      )
    ).toThrow(/disable provider-native tools/i)

    const grokPlan = providerLaunchPlan('grok') as ProviderLaunchAuthorityInputByProvider['grok']
    const scheduledGrok = task({
      provider: 'grok',
      runtimeProfileId: undefined,
      selectedModelType: 'grok-model'
    })
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(scheduledGrok, {
          runtimeSeats: [
            defaultSeat('grok', {
              effective: effectiveAuthority('grok', {
                providerLaunchAuthority: {
                  ...grokPlan,
                  controls: { ...grokPlan.controls, webSearchEnabled: true }
                }
              })
            })
          ]
        }),
        now
      )
    ).toThrow(/cannot enable provider web search/i)
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(scheduledGrok, {
          runtimeSeats: [
            defaultSeat('grok', {
              effective: effectiveAuthority('grok', {
                effectiveMcpProfileId: null,
                providerLaunchAuthority: grokStreamingReadOnlyPlan(true)
              })
            })
          ]
        }),
        now
      )
    ).toThrow(/cannot enable provider web search/i)

    const mcpDenied = effectivePermissions({
      agenticServices: {
        ...effectivePermissions().agenticServices,
        mcpTools: 'deny'
      }
    })
    const scheduledCodex = task({ runtimeProfileId: undefined })
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(scheduledCodex, {
          runtimeSeats: [
            defaultSeatForPermissions('codex', mcpDenied, providerLaunchPlan('codex'))
          ]
        }),
        now
      )
    ).toThrow(/denied MCP posture cannot advertise/i)

    const toollessExec = codexLaunchPlan(
      { transport: 'exec-json', approvalPolicy: 'never' },
      { advertiseTaskWraithMcp: false }
    )
    expect(
      mintScheduledOccurrenceSeal(
        ROOT,
        context(scheduledCodex, {
          runtimeSeats: [defaultSeatForPermissions('codex', mcpDenied, toollessExec)]
        }),
        now
      )
    ).toMatchObject({ schemaVersion: 2 })
  })

  it('maps Cursor read-only, plan, and write postures to exact bridge tiers', () => {
    const readOnly = effectivePermissions()
    const plan = effectivePermissions({ presetId: 'plan' })
    const write = effectivePermissions({
      presetId: 'workspace_write',
      approvalMode: 'default',
      readOnly: false
    })
    const accepted: Array<
      [EffectiveRunPermissions, ProviderLaunchAuthorityInputByProvider['cursor']]
    > = [
      [readOnly, cursorBridgePlan('safe-subset')],
      [readOnly, cursorBridgePlan('none')],
      [plan, cursorBridgePlan('plan-subset')],
      [plan, cursorBridgePlan('none')],
      [write, cursorBridgePlan('full')]
    ]
    for (const [permissions, launch] of accepted) {
      const scheduled = task({
        provider: 'cursor',
        runtimeProfileId: undefined,
        selectedModelType: 'cursor-model',
        approvalMode: permissions.approvalMode,
        permissionPresetId: permissions.presetId
      })
      expect(
        mintScheduledOccurrenceSeal(
          ROOT,
          context(scheduled, {
            runtimeSeats: [defaultSeatForPermissions('cursor', permissions, launch)]
          }),
          now
        )
      ).toMatchObject({ schemaVersion: 2 })
    }

    const rejected: Array<
      [EffectiveRunPermissions, ProviderLaunchAuthorityInputByProvider['cursor']]
    > = [
      [readOnly, cursorBridgePlan('plan-subset')],
      [plan, cursorBridgePlan('safe-subset')],
      [write, cursorBridgePlan('safe-subset')],
      [readOnly, cursorBridgePlan('safe-subset', 'plan')]
    ]
    for (const [permissions, launch] of rejected) {
      const scheduled = task({
        provider: 'cursor',
        runtimeProfileId: undefined,
        selectedModelType: 'cursor-model',
        approvalMode: permissions.approvalMode,
        permissionPresetId: permissions.presetId
      })
      expect(() =>
        mintScheduledOccurrenceSeal(
          ROOT,
          context(scheduled, {
            runtimeSeats: [defaultSeatForPermissions('cursor', permissions, launch)]
          }),
          now
        )
      ).toThrow(/bridge mode does not match|execution mode does not match/i)
    }
  })

  it('uses a canonical Ollama HTTP marker and rejects selected CLI-style overrides', () => {
    const ollamaProfile = profile({
      id: 'profile-ollama',
      name: 'Ollama scheduled',
      provider: 'ollama',
      binaryPath: undefined,
      env: {},
      secretRefs: undefined,
      containerConfig: undefined
    })
    const scheduled = task({
      provider: 'ollama',
      runtimeProfileId: ollamaProfile.id,
      selectedModelType: 'ollama-model'
    })
    expect(
      mintScheduledOccurrenceSeal(
        ROOT,
        context(scheduled, { runtimeSeats: [selectedSeat(ollamaProfile)] }),
        now
      )
    ).toMatchObject({ schemaVersion: 2 })

    for (const candidate of [
      profile({ ...ollamaProfile, binaryPath: providerBinary('ollama') }),
      profile({ ...ollamaProfile, env: { OLLAMA_HOST: 'http://localhost:11434' } }),
      profile({ ...ollamaProfile, secretRefs: { env: ['OLLAMA_TOKEN'] } })
    ]) {
      expect(() =>
        mintScheduledOccurrenceSeal(
          ROOT,
          context(scheduled, { runtimeSeats: [selectedSeat(candidate)] }),
          now
        )
      ).toThrow(/Ollama HTTP runtime profile cannot carry CLI binary or environment overrides/i)
    }
  })

  it('seals an explicit default-runtime and posture seat for a cross-provider verifier', () => {
    const linked = linkedTask()
    const workflow = workflowFor(linked, {
      loop: {
        acceptance: { maxIterations: 2, verifier: { provider: 'claude' } },
        limits: { maxRuns: 4 }
      }
    })
    const current = context(linked, { workflow })
    const seal = mint(current)
    expect(current.runtimeSeats.map((seat) => seat.seatId).sort()).toEqual([
      SCHEDULED_LOOP_VERIFIER_SEAT_ID,
      'root'
    ])
    expect(verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, current)).not.toBeNull()

    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(linked, { workflow, runtimeSeats: [current.runtimeSeats[0]] }),
        now
      )
    ).toThrow(/seat set does not match/i)
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(linked, { workflow, effectiveLoopVerifierProvider: 'codex' }),
        now
      )
    ).toThrow(/does not match the workflow/i)
    const changedVerifierRuntime = context(linked, {
      workflow,
      runtimeSeats: current.runtimeSeats.map((seat) =>
        seat.seatId === SCHEDULED_LOOP_VERIFIER_SEAT_ID
          ? defaultSeat('claude', {
              seatId: SCHEDULED_LOOP_VERIFIER_SEAT_ID,
              effective: effectiveAuthority('claude', {
                providerLaunchAuthority: {
                  ...providerLaunchPlan('claude'),
                  common: {
                    ...providerLaunchPlan('claude').common,
                    modelCapabilitySha256: '9'.repeat(64)
                  }
                } as ProviderLaunchAuthorityInputByProvider['claude']
              })
            })
          : seat
      )
    })
    persistSeal(changedVerifierRuntime, seal)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        KEY,
        seal,
        changedVerifierRuntime
      )
    ).toBeNull()

    const retiredWorkflow = workflowFor(linked, {
      loop: {
        acceptance: { maxIterations: 2, verifier: { provider: 'gemini' } },
        limits: { maxRuns: 4 }
      }
    })
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(linked, {
          workflow: retiredWorkflow,
          effectiveLoopVerifierProvider: 'gemini',
          runtimeSeats: []
        }),
        now
      )
    ).toThrow(/retired/i)
  })

  it('reuses the maker seat for a same-provider verifier', () => {
    const linked = linkedTask()
    const workflow = workflowFor(linked, {
      loop: {
        acceptance: { maxIterations: 2, verifier: { provider: 'codex' } },
        limits: { maxRuns: 4 }
      }
    })
    const current = context(linked, { workflow })
    expect(current.runtimeSeats.map((seat) => seat.seatId)).toEqual(['root'])
    expect(() => mint(current)).not.toThrow()
  })

  it('derives deterministic Ensemble seat sets and checks participant posture identity', () => {
    const ensemble = task({
      runtimeProfileId: undefined,
      kind: 'ensemble',
      ensembleSnapshot: {
        orchestrationMode: 'continuous',
        participants: [
          {
            id: 'boss',
            provider: 'codex',
            enabled: true,
            role: 'Boss',
            instructions: 'Lead.',
            order: 1,
            runtimeProfileId: 'profile-codex'
          },
          {
            id: 'scout',
            provider: 'grok',
            enabled: true,
            role: 'Scout',
            instructions: 'Map.',
            order: 2
          },
          {
            id: 'disabled',
            provider: 'claude',
            enabled: false,
            role: 'Disabled',
            instructions: '',
            order: 3
          }
        ],
        capturedAt: now
      }
    })
    const seats = defaultRuntimeSeats(ensemble, null)
    const first = mintScheduledOccurrenceSeal(
      ROOT,
      context(ensemble, { runtimeSeats: seats }),
      now
    )
    const second = mintScheduledOccurrenceSeal(
      ROOT,
      context(ensemble, { runtimeSeats: defaultRuntimeSeats(ensemble, null).reverse() }),
      now
    )
    expect(second.runtimeProfileSetHmac).toBe(first.runtimeProfileSetHmac)
    expect(second.permissionPostureSetHmac).toBe(first.permissionPostureSetHmac)
    const allDisabled = structuredClone(ensemble)
    for (const participant of allDisabled.ensembleSnapshot!.participants) {
      participant.enabled = false
    }
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(allDisabled, { runtimeSeats: [] }),
        now
      )
    ).toThrow(/enabled participant/i)
    const mismatchedSeats = defaultRuntimeSeats(ensemble, null)
    expect(() =>
      mintScheduledOccurrenceSeal(
        ROOT,
        context(ensemble, {
          runtimeSeats: [
            mismatchedSeats[0],
            {
              ...mismatchedSeats[1],
              permissionPostureCapability: postureCapability('grok', 'wrong-participant')
            }
          ]
        }),
        now
      )
    ).toThrow(/participant does not match/i)
  })
})

describe('strict persisted seal schema', () => {
  it('decodes legacy v1 only for migration and never authorizes queued-v1 replay', () => {
    const current = context()
    const legacy = legacySealV1(mint(current))
    const decoded = decodeLegacyScheduledOccurrenceSealV1ForMigration(
      structuredClone(legacy)
    )

    expect(decoded).toEqual(legacy)
    expect(decoded).not.toBe(legacy)
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(ROOT, legacy, current)
    ).toBeNull()
    expect(
      decodeLegacyScheduledOccurrenceSealV1ForMigration({ ...legacy, extra: true })
    ).toBeNull()
    expect(
      decodeLegacyScheduledOccurrenceSealV1ForMigration(omit(legacy, 'sealSignature'))
    ).toBeNull()
  })

  it('accepts only an authority-root capability and canonical timestamps/paths/hashes', () => {
    expect(() =>
      mintScheduledOccurrenceSeal(
        Buffer.alloc(32) as unknown as ScheduledOccurrenceAuthorityRoot,
        context(),
        now
      )
    ).toThrow(/rootId/i)
    const current = context()
    const seal = mint(current)
    expect(Object.keys(seal).sort()).toEqual(
      [
        'schemaVersion',
        'rootId',
        'issuedAt',
        'ownerRunId',
        'rootOwner',
        'taskAuthorityDigest',
        'compositeWorkflowAuthorityDigest',
        'workspaceRealPath',
        'runtimeProfileSetHmac',
        'permissionPostureSetHmac',
        'sealMac'
      ].sort()
    )
    expect(() =>
      mintScheduledOccurrenceSeal(
        KEY,
        {
          ...current,
          task: { ...current.task, occurrenceSeal: undefined },
          // A bare filesystem root is rejected on every platform.
          workspaceRealPath: parse(REAL_WORKSPACE_PATH).root
        },
        now
      )
    ).toThrow(/canonical absolute path/i)
    for (const invalid of [
      { ...seal, extra: true },
      omit(seal, 'taskAuthorityDigest'),
      { ...seal, schemaVersion: 1 },
      { ...seal, rootId: 'twso-root-v1:not-a-root' },
      { ...seal, issuedAt: '2026-07-14T12:00:00Z' },
      { ...seal, ownerRunId: '' },
      { ...seal, rootOwner: 'caller-root' },
      { ...seal, workspaceRealPath: 'relative/workspace' },
      // Trailing separator keeps this non-canonical on every platform.
      { ...seal, workspaceRealPath: `${REAL_WORKSPACE_PATH}${sep}` },
      { ...seal, taskAuthorityDigest: seal.taskAuthorityDigest.toUpperCase() }
    ]) {
      expect(
        verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, invalid, current)
      ).toBeNull()
    }
  })

  it('rejects field-by-field seal tampering', () => {
    const current = context()
    const seal = mint(current)
    for (const candidate of [
      { ...seal, rootId: `twso-root-v1:${'2'.repeat(64)}` },
      { ...seal, issuedAt: '2026-07-14T12:00:01.000Z' },
      { ...seal, ownerRunId: 'other-owner' },
      { ...seal, rootOwner: 'ensemble-root' },
      { ...seal, taskAuthorityDigest: '1'.repeat(64) },
      { ...seal, compositeWorkflowAuthorityDigest: '2'.repeat(64) },
      { ...seal, workspaceRealPath: OTHER_REAL_PATH },
      { ...seal, runtimeProfileSetHmac: '3'.repeat(64) },
      { ...seal, permissionPostureSetHmac: '4'.repeat(64) },
      { ...seal, sealMac: '5'.repeat(64) }
    ]) {
      expect(
        verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, candidate, current)
      ).toBeNull()
    }
  })
})

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value }
  delete clone[key]
  return clone
}

void (null as ScheduledOccurrenceAuthorityPhase | null)
