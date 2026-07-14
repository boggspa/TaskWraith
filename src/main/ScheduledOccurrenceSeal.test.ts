import { describe, expect, it } from 'vitest'
import {
  RUNTIME_PROFILE_AUTHORITY_FIELD_POLICY,
  SCHEDULED_LOOP_VERIFIER_SEAT_ID,
  buildDefaultRuntimeLaunchAuthority,
  buildEffectiveRuntimeLaunchAuthority,
  buildRuntimeProfileAuthority,
  deriveScheduledOccurrenceSealPayload,
  mintScheduledOccurrenceSeal,
  scheduledTaskAuthorityDigest,
  verifyScheduledOccurrenceSealAgainstCurrentContext,
  type EffectiveRuntimeLaunchAuthority,
  type ScheduledOccurrenceAuthorityPhase,
  type ScheduledOccurrenceCurrentContext,
  type ScheduledOccurrenceRuntimeSeatContext
} from './ScheduledOccurrenceSeal'
import type {
  ProviderId,
  RunPermissionPostureSnapshot,
  RuntimeProfile,
  ScheduledOccurrenceSeal,
  ScheduledTask,
  WorkflowDefinition,
  WorkflowRunTemplate
} from './store/types'

const KEY = Buffer.alloc(32, 19)
const now = '2026-07-14T12:00:00.000Z'
const plannedFor = '2026-07-14T13:00:00.000Z'
const runAt = '2026-07-14T13:05:00.000Z'
const canonicalPath = (value: string): string => value.replace(/\/+$/, '') || '/'

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'scheduled-1',
    workspaceId: 'workspace-1',
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
    permissionPosture: posture('codex', 'root', 'a', 'b'),
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
    binaryPath: '/opt/taskwraith/bin/codex',
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

function effectiveAuthority(
  provider: ProviderId = 'codex',
  overrides: Partial<EffectiveRuntimeLaunchAuthority> = {}
): EffectiveRuntimeLaunchAuthority {
  return {
    schemaVersion: 1,
    provider,
    effectiveBinary: `/opt/taskwraith/bin/${provider}`,
    effectiveWorkspaceMode: 'local',
    effectiveMcpProfileId: 'taskwraith-full-v1',
    effectiveApprovalMode: 'default',
    effectiveAgenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'workspace',
      externalPublish: 'deny',
      mcpTools: 'workspace',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      canvasEval: 'deny',
      crossThreadRead: 'deny',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      networkAccess: 'deny'
    },
    effectiveNetworkPolicy: 'deny',
    effectivePersistence: 'reusable',
    providerLaunchAuthorityDigest: providerDigest(provider),
    ...overrides
  }
}

function providerDigest(provider: ProviderId, marker = '7'): string {
  return `${provider.length.toString(16)}${marker.repeat(63)}`.slice(0, 64)
}

function posture(
  provider: ProviderId,
  seatId: string,
  hashMarker = 'a',
  signatureMarker = 'b',
  runtimeProfileId?: string
): RunPermissionPostureSnapshot {
  return {
    schemaVersion: 1,
    approvalMode: 'plan',
    workflowMode: 'normal',
    presetId: 'read_only',
    readOnly: true,
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
    externalPathGrantCount: 0,
    workspaceGrantServiceIds: [],
    postureHash: hashMarker.repeat(64),
    signature: signatureMarker.repeat(64),
    signaturePresent: true,
    context: {
      provider,
      scope: 'workspace',
      appRunId: 'scheduled-1',
      appChatId: 'chat-1',
      workflowMode: 'normal',
      ...(runtimeProfileId ? { runtimeProfileId } : {}),
      ...(seatId !== 'root' && seatId !== SCHEDULED_LOOP_VERIFIER_SEAT_ID
        ? { ensembleParticipantId: seatId }
        : {})
    }
  }
}

function selectedSeat(
  selectedProfile: RuntimeProfile = profile(),
  options: {
    seatId?: string
    resolvedEnv?: Record<string, string>
    effective?: EffectiveRuntimeLaunchAuthority
    permissionPosture?: RunPermissionPostureSnapshot
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
    permissionPostureAuthority:
      options.permissionPosture ??
      posture(selectedProfile.provider, seatId, 'a', 'b', selectedProfile.id)
  }
}

function defaultSeat(
  provider: ProviderId,
  options: {
    seatId?: string
    resolvedEnv?: Record<string, string>
    effective?: EffectiveRuntimeLaunchAuthority
    permissionPosture?: RunPermissionPostureSnapshot
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
    permissionPostureAuthority:
      options.permissionPosture ?? posture(provider, seatId)
  }
}

function context(
  scheduledTask: ScheduledTask = task(),
  overrides: Partial<ScheduledOccurrenceCurrentContext> = {}
): ScheduledOccurrenceCurrentContext {
  const workflow = overrides.workflow === undefined ? null : overrides.workflow
  const effectiveLoopVerifierProvider =
    overrides.effectiveLoopVerifierProvider !== undefined
      ? overrides.effectiveLoopVerifierProvider
      : workflow?.loop?.acceptance.verifier
        ? workflow.loop.acceptance.verifier.provider ?? scheduledTask.provider
        : null
  return {
    task: scheduledTask,
    workflow,
    canonicalizePath: canonicalPath,
    workspaceRealPath: '/real/workspace',
    runtimeSeats:
      overrides.runtimeSeats ?? defaultRuntimeSeats(scheduledTask, workflow),
    phase: overrides.phase ?? { kind: 'queued' },
    effectiveLoopVerifierProvider,
    ...overrides
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
                binaryPath: `/opt/taskwraith/bin/${participant.provider}`
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
          binaryPath: `/opt/taskwraith/bin/${scheduledTask.provider}`
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
  return { ...current, status: 'running', runId: ownerRunId, runningSince: now }
}

function runningWorkflow(
  current: WorkflowDefinition,
  ownerRunId = 'run-owner'
): WorkflowDefinition {
  return {
    ...current,
    history: current.history.map((execution) =>
      execution.id === current.activeExecutionId
        ? { ...execution, status: 'running', runId: ownerRunId, startedAt: now }
        : execution
    )
  }
}

function mint(current: ScheduledOccurrenceCurrentContext = context()): ScheduledOccurrenceSeal {
  return mintScheduledOccurrenceSeal(KEY, current, now)
}

describe('ScheduledOccurrenceSeal lifecycle and posture authority', () => {
  it('mints and verifies a queued occurrence without persisting resolved secrets', () => {
    const current = context()
    const seal = mint(current)
    const persisted = structuredClone(seal)
    const verified = verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, persisted, current)

    expect(verified).toEqual(seal)
    expect(verified).not.toBe(persisted)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(JSON.stringify(seal)).not.toContain('resolved-secret-token')
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(Buffer.alloc(32, 20), seal, current)
    ).toBeNull()
  })

  it('separates queued minting from final running-owner verification', () => {
    const queued = context()
    const seal = mint(queued)
    const ownerRunId = 'run-owner'
    const running = context(runningTask(queued.task, ownerRunId), {
      phase: { kind: 'running', ownerRunId }
    })
    expect(verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, running)).not.toBeNull()
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, {
        ...running,
        phase: { kind: 'running', ownerRunId: 'other-owner' }
      })
    ).toBeNull()
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, {
        ...running,
        phase: { kind: 'queued' }
      })
    ).toBeNull()
    expect(() => mint(running)).toThrow(/before run ownership/i)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        KEY,
        seal,
        context({ ...queued.task, status: 'completed' })
      )
    ).toBeNull()
  })

  it('uses freshly derived per-seat posture authority, never the persisted task snapshot', () => {
    const current = context()
    const seal = mint(current)
    const changedPersistedPosture = task({
      permissionPosture: posture('codex', 'root', 'c', 'd')
    })
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        KEY,
        seal,
        context(changedPersistedPosture)
      )
    ).not.toBeNull()

    const changedFreshPosture = context(current.task, {
      runtimeSeats: [
        selectedSeat(profile(), {
          permissionPosture: posture('codex', 'root', 'c', 'd', 'profile-codex')
        })
      ]
    })
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, changedFreshPosture)
    ).toBeNull()
    expect(() =>
      deriveScheduledOccurrenceSealPayload(
        KEY,
        context(current.task, {
          runtimeSeats: [
            selectedSeat(profile(), {
              permissionPosture: {
                ...posture('codex', 'root', 'a', 'b', 'profile-codex'),
                signaturePresent: false,
                signature: undefined
              }
            })
          ]
        }),
        now
      )
    ).toThrow(/fresh signed permission posture/i)
    expect(() =>
      deriveScheduledOccurrenceSealPayload(
        KEY,
        context(current.task, {
          runtimeSeats: [
            selectedSeat(profile(), {
              permissionPosture: posture('claude', 'root', 'a', 'b', 'profile-codex')
            })
          ]
        }),
        now
      )
    ).toThrow(/provider does not match/i)

    const correct = posture('codex', 'root', 'a', 'b', 'profile-codex')
    const contextMismatches: Array<Partial<NonNullable<typeof correct.context>>> = [
      { scope: 'global' },
      { appRunId: 'other-occurrence' },
      { appChatId: 'other-chat' },
      { runtimeProfileId: 'other-profile' },
      { ensembleParticipantId: 'smuggled-participant' }
    ]
    for (const contextPatch of contextMismatches) {
      expect(() =>
        deriveScheduledOccurrenceSealPayload(
          KEY,
          context(current.task, {
            runtimeSeats: [
              selectedSeat(profile(), {
                permissionPosture: {
                  ...correct,
                  context: { ...correct.context!, ...contextPatch }
                }
              })
            ]
          }),
          now
        )
      ).toThrow(/posture (context|cannot claim)/i)
    }
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
          permissionPosture: posture('codex', 'root', 'c', 'd'),
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
    const queued = context(linked, { workflow })
    const seal = mint(queued)
    expect(linked.workflowOccurrenceAt).toBe(plannedFor)
    expect(linked.runAt).toBe(runAt)
    expect(verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, queued)).not.toBeNull()

    const ownerRunId = 'workflow-owner'
    const running = context(runningTask(linked, ownerRunId), {
      workflow: runningWorkflow(workflow, ownerRunId),
      phase: { kind: 'running', ownerRunId }
    })
    expect(verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, running)).not.toBeNull()
  })

  it('requires exact workflow phase, owner, linkage and current template authority', () => {
    const linked = linkedTask()
    const workflow = workflowFor(linked)
    const queued = context(linked, { workflow })
    const seal = mint(queued)

    expect(() =>
      deriveScheduledOccurrenceSealPayload(
        KEY,
        context(linked, {
          workflow: runningWorkflow(workflow),
          phase: { kind: 'queued' }
        }),
        now
      )
    ).toThrow(/not queued and unowned/i)
    expect(() =>
      deriveScheduledOccurrenceSealPayload(
        KEY,
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
        ...queued,
        workflow: { ...workflow, limits: { ...workflow.limits, maxRunsPerDay: 3 } }
      })
    ).toBeNull()
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(KEY, seal, {
        ...queued,
        workflow: { ...workflow, enabled: !workflow.enabled }
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
    const expected = deriveScheduledOccurrenceSealPayload(KEY, current, now).runtimeProfileSetHmac
    const profileVariants: RuntimeProfile[] = [
      profile({ workspaceMode: 'worktree' }),
      profile({ binaryPath: '/other/codex' }),
      profile({ env: { PUBLIC_MODE: 'changed' } }),
      profile({ secretRefs: { env: ['OTHER_TOKEN'] } }),
      profile({ mcpProfileId: 'taskwraith-core-v1' }),
      profile({ agenticServices: { fileChanges: 'deny' } }),
      profile({ networkPolicy: 'allow' }),
      profile({ persistence: 'ephemeral' })
    ]
    for (const candidate of profileVariants) {
      expect(
        deriveScheduledOccurrenceSealPayload(
          KEY,
          context(current.task, { runtimeSeats: [selectedSeat(candidate)] }),
          now
        ).runtimeProfileSetHmac
      ).not.toBe(expected)
    }

    const effectiveVariants: Partial<EffectiveRuntimeLaunchAuthority>[] = [
      { effectiveBinary: '/other/codex' },
      { effectiveWorkspaceMode: 'worktree' },
      { effectiveMcpProfileId: 'taskwraith-core-v1' },
      { effectiveApprovalMode: 'plan' },
      { effectiveNetworkPolicy: 'allow' },
      { effectivePersistence: 'ephemeral' },
      { providerLaunchAuthorityDigest: '8'.repeat(64) }
    ]
    for (const override of effectiveVariants) {
      expect(
        deriveScheduledOccurrenceSealPayload(
          KEY,
          context(current.task, {
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
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority(),
        providerLaunchAuthority: { transport: 'app-server' }
      } as never)
    ).toThrow(/invalid field set/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority(),
        providerLaunchAuthorityDigest: 'not-a-digest'
      })
    ).toThrow(/canonical SHA-256/i)
    const missingAgenticField = { ...effectiveAuthority().effectiveAgenticServices }
    delete (missingAgenticField as Partial<typeof missingAgenticField>).mediaRecording
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effectiveAuthority(),
        effectiveAgenticServices: missingAgenticField as never
      })
    ).toThrow(/invalid field set/i)
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
      deriveScheduledOccurrenceSealPayload(
        KEY,
        context(linked, { workflow, runtimeSeats: [current.runtimeSeats[0]] }),
        now
      )
    ).toThrow(/seat set does not match/i)
    expect(() =>
      deriveScheduledOccurrenceSealPayload(
        KEY,
        context(linked, { workflow, effectiveLoopVerifierProvider: 'codex' }),
        now
      )
    ).toThrow(/does not match the workflow/i)
    expect(
      verifyScheduledOccurrenceSealAgainstCurrentContext(
        KEY,
        seal,
        context(linked, {
          workflow,
          runtimeSeats: current.runtimeSeats.map((seat) =>
            seat.seatId === SCHEDULED_LOOP_VERIFIER_SEAT_ID
              ? defaultSeat('claude', {
                  seatId: SCHEDULED_LOOP_VERIFIER_SEAT_ID,
                  effective: effectiveAuthority('claude', {
                    providerLaunchAuthorityDigest: '9'.repeat(64)
                  })
                })
              : seat
          )
        })
      )
    ).toBeNull()

    const retiredWorkflow = workflowFor(linked, {
      loop: {
        acceptance: { maxIterations: 2, verifier: { provider: 'gemini' } },
        limits: { maxRuns: 4 }
      }
    })
    expect(() =>
      deriveScheduledOccurrenceSealPayload(
        KEY,
        context(linked, {
          workflow: retiredWorkflow,
          effectiveLoopVerifierProvider: 'gemini'
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
    const first = deriveScheduledOccurrenceSealPayload(
      KEY,
      context(ensemble, { runtimeSeats: seats }),
      now
    )
    const second = deriveScheduledOccurrenceSealPayload(
      KEY,
      context(ensemble, { runtimeSeats: [...seats].reverse() }),
      now
    )
    expect(second.runtimeProfileSetHmac).toBe(first.runtimeProfileSetHmac)
    expect(second.permissionPostureSetHmac).toBe(first.permissionPostureSetHmac)
    const allDisabled = structuredClone(ensemble)
    for (const participant of allDisabled.ensembleSnapshot!.participants) {
      participant.enabled = false
    }
    expect(() =>
      deriveScheduledOccurrenceSealPayload(
        KEY,
        context(allDisabled, { runtimeSeats: [] }),
        now
      )
    ).toThrow(/enabled participant/i)
    expect(() =>
      deriveScheduledOccurrenceSealPayload(
        KEY,
        context(ensemble, {
          runtimeSeats: [
            seats[0],
            {
              ...seats[1],
              permissionPostureAuthority: posture('grok', 'wrong-participant')
            }
          ]
        }),
        now
      )
    ).toThrow(/participant does not match/i)
  })
})

describe('strict persisted seal schema', () => {
  it('accepts only strong Buffer keys and canonical timestamps/paths/hashes', () => {
    expect(() => mintScheduledOccurrenceSeal(Buffer.alloc(31), context(), now)).toThrow(
      /at least 32 bytes/i
    )
    expect(() =>
      mintScheduledOccurrenceSeal('not-a-buffer' as unknown as Buffer, context(), now)
    ).toThrow(/at least 32 bytes/i)
    const current = context()
    const seal = mint(current)
    expect(() =>
      mintScheduledOccurrenceSeal(
        KEY,
        { ...current, workspaceRealPath: '/' },
        now
      )
    ).toThrow(/canonical absolute path/i)
    for (const invalid of [
      { ...seal, extra: true },
      omit(seal, 'taskAuthorityDigest'),
      { ...seal, issuedAt: '2026-07-14T12:00:00Z' },
      { ...seal, workspaceRealPath: 'relative/workspace' },
      { ...seal, workspaceRealPath: '/real/workspace/' },
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
      { ...seal, issuedAt: '2026-07-14T12:00:01.000Z' },
      { ...seal, taskAuthorityDigest: '1'.repeat(64) },
      { ...seal, compositeWorkflowAuthorityDigest: '2'.repeat(64) },
      { ...seal, workspaceRealPath: '/real/other' },
      { ...seal, runtimeProfileSetHmac: '3'.repeat(64) },
      { ...seal, permissionPostureSetHmac: '4'.repeat(64) },
      { ...seal, sealSignature: '5'.repeat(64) }
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
