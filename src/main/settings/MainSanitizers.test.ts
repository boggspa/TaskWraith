import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMainSanitizers,
  consolidateAgenticWorkspaceGrants,
  normalizeEnsembleRunIdentity,
  normalizeAuditRunIdentity,
  sanitizeAuditOrchestration,
  assertProviderId,
  assertLiveProviderId,
  availableProviderIds,
  selectableProviderIds,
  MIN_INSPECTOR_WIDTH,
  MAX_INSPECTOR_WIDTH
} from './MainSanitizers'
import type { AppSettings, ExternalPathGrant, WorkspaceRecord } from '../store/types'
import { MAX_DURABLE_ATTACHMENT_REFS } from '../ScheduledAttachmentDurability'
import {
  resetAntigravityGeminiApiKeyConfiguredProbeForTests,
  setAntigravityGeminiApiKeyConfiguredProbe
} from '../antigravity/AntigravityGeminiApiKeyConfiguredSignal'

describe('normalizeAuditRunIdentity', () => {
  it('accepts a valid audit role identity with optional dimension/findingId', () => {
    expect(
      normalizeAuditRunIdentity({
        auditRunId: 'a1',
        role: 'reviewer',
        dimension: 'code health'
      })
    ).toEqual({ auditRunId: 'a1', role: 'reviewer', dimension: 'code health' })
    expect(
      normalizeAuditRunIdentity({ auditRunId: 'a1', role: 'skeptic', findingId: 'f1' })
    ).toEqual({ auditRunId: 'a1', role: 'skeptic', findingId: 'f1' })
  })

  it('rejects an unknown role or non-record', () => {
    expect(normalizeAuditRunIdentity({ auditRunId: 'a1', role: 'hacker' })).toBeUndefined()
    expect(normalizeAuditRunIdentity(null)).toBeUndefined()
    expect(normalizeAuditRunIdentity({ role: 'recon' })).toBeUndefined() // missing id
  })
})

describe('normalizeEnsembleRunIdentity', () => {
  it('preserves lane and stage-role dispatch identity', () => {
    expect(
      normalizeEnsembleRunIdentity({
        roundId: 'round-1',
        participantId: 'codex-worker',
        laneId: 'lane-round-1-codex-worker-1',
        provider: 'codex',
        role: 'Worker',
        promptMode: 'slim',
        stageRole: 'worker',
        order: 2,
        ensembleContextChars: 24000,
        ensembleContextTurns: 4
      })
    ).toEqual({
      roundId: 'round-1',
      participantId: 'codex-worker',
      laneId: 'lane-round-1-codex-worker-1',
      provider: 'codex',
      role: 'Worker',
      promptMode: 'slim',
      stageRole: 'worker',
      order: 2,
      ensembleContextChars: 24000,
      ensembleContextTurns: 4
    })
    expect(
      normalizeEnsembleRunIdentity({
        roundId: 'round-bg',
        participantId: 'claude-bg',
        provider: 'claude',
        role: 'Shell helper',
        stageRole: 'background',
        order: 4
      })
    ).toMatchObject({ stageRole: 'background' })
  })

  it('drops invalid stage roles rather than preserving untrusted values', () => {
    expect(
      normalizeEnsembleRunIdentity({
        roundId: 'round-1',
        participantId: 'codex-worker',
        provider: 'codex',
        role: 'Worker',
        stageRole: 'boss',
        order: 2
      })
    ).toEqual({
      roundId: 'round-1',
      participantId: 'codex-worker',
      provider: 'codex',
      role: 'Worker',
      order: 2
    })
  })
})

describe('sanitizeAuditOrchestration', () => {
  it('drops unknown providers from the allowlist + per-role prefs', () => {
    const out = sanitizeAuditOrchestration({
      providerAllowlist: ['claude', 'bogus', 'codex'],
      perRolePreferences: { skeptic: ['grok', 'nope'], junk: ['claude'] }
    })
    expect(out?.providerAllowlist).toEqual(['claude', 'codex'])
    expect(out?.perRolePreferences).toEqual({ skeptic: ['grok'] })
  })

  it('clamps the ollama concurrency cap to 1..4 and budgets to bounds', () => {
    expect(sanitizeAuditOrchestration({ ollamaMaxConcurrent: 99 })?.ollamaMaxConcurrent).toBe(4)
    expect(sanitizeAuditOrchestration({ ollamaMaxConcurrent: 0 })?.ollamaMaxConcurrent).toBe(1)
    expect(sanitizeAuditOrchestration({ budgetMaxAgents: 9999 })?.budgetMaxAgents).toBe(200)
  })

  it('keeps ollamaEnabled boolean and returns undefined for empty/garbage input', () => {
    expect(sanitizeAuditOrchestration({ ollamaEnabled: true })?.ollamaEnabled).toBe(true)
    expect(sanitizeAuditOrchestration({})).toBeUndefined()
    expect(sanitizeAuditOrchestration(null)).toBeUndefined()
    expect(sanitizeAuditOrchestration({ providerAllowlist: ['nope'] })?.providerAllowlist).toEqual(
      []
    )
  })
})

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'gemini',
    storeLocalChatHistory: true,
    storeRawEvents: false,
    storePromptResponseInUsage: false,
    ensembleModeEnabled: true,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 6,
    appearanceMode: 'soft_glass',
    visualEffectStyle: 'auto',
    themeAppearance: 'system',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    toolIconAccent: 'system',
    userBubbleColor: 'system',
    promptSurfaceStyle: 'liquid_glass',
    composerStyle: 'default',
    funFxEnabled: true,
    funFxMode: 'cinematic',
    advancedFx: {
      agentAura: true,
      livingWorkspace: true,
      dataViz: true,
      refraction: true,
      intensity: 'cinematic'
    },
    currency: 'USD',
    currencyOverestimatePercent: 0,
    welcomeHeatmapPrefs: {
      workspaceActivityEnabled: true,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true
    },
    kimiSanitiserEnabled: false,
    kimiSanitiserCustomKeywords: '',
    reduceTransparency: false,
    reduceMotion: false,
    compactDensity: false,
    liveActivityViewport: true,
    showInspector: true,
    inspectorWidth: 380,
    sidebarWidth: 260,
    agenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      networkAccess: 'allow'
    },
    agenticWorkspaceGrants: [],
    nativeSubAgentRequests: 'ask',
    autoResumeParentOnSubThreadCompletion: true,
    geminiMcpBridgeEnabled: false,
    bridgeDaemonEnabled: true,
    codexSandboxFallback: 'ask_rerun',
    updateChannel: 'debug',
    approvalTimeouts: {
      enabled: true,
      perProviderMs: {
        gemini: 120_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000,
        grok: 120_000,
        cursor: 120_000,
        ollama: 120_000
      },
      mainAuthorityMs: 60_000
    },
    ...overrides
  } as AppSettings
}

function workspaceChat(workspacePath = '/tmp/taskwraith-workspace') {
  return {
    appChatId: 'chat-1',
    archived: false,
    scope: 'workspace' as const,
    workspaceId: 'workspace-1',
    workspacePath
  }
}

function makeSanitizers(
  settings: AppSettings,
  overrides: Partial<Parameters<typeof createMainSanitizers>[0]> = {}
) {
  const workspace: WorkspaceRecord = {
    id: 'workspace-1',
    path: '/tmp/taskwraith-workspace',
    displayName: 'Workspace',
    lastOpenedAt: 1,
    createdAt: 1,
    pinned: false
  }
  return createMainSanitizers({
    getSettings: () => settings,
    getScheduledTasks: () => [],
    getWorkflowDefinitions: () => [],
    getChat: (id) => (id === 'chat-1' ? workspaceChat(workspace.path) : null),
    findRegisteredWorkspace: (workspacePath: string) =>
      workspacePath === workspace.path ? workspace : undefined,
    requireRegisteredWorkspace: (workspacePath: string) => workspacePath,
    canonicalPath: (value: string) => value,
    normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => grants,
    stageScheduledAttachments: ({ attachments }) => ({
      ok: true,
      attachments: attachments.map((attachment) => ({
        persistenceVersion: 1,
        id: attachment.id,
        path: `/tmp/taskwraith-assets/${attachment.id}.png`,
        name: attachment.name,
        sha256: 'a'.repeat(43),
        mimeType: 'image/png',
        byteLength: 8
      }))
    }),
    ...overrides
  })
}

describe('MainSanitizers scheduled tasks', () => {
  it('rejects invalid or past run times before saving scheduled work', () => {
    const { sanitizeScheduledTaskForSave } = makeSanitizers(makeSettings())
    const baseTask = {
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace',
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Run later',
      runAt: new Date(Date.now() + 60_000).toISOString(),
      timezone: 'Europe/London'
    }

    expect(() => sanitizeScheduledTaskForSave({ ...baseTask, runAt: 'not-a-date' })).toThrow(
      'Scheduled task run time is invalid.'
    )
    expect(() =>
      sanitizeScheduledTaskForSave({
        ...baseTask,
        runAt: new Date(Date.now() - 60_000).toISOString()
      })
    ).toThrow('Scheduled task run time must be in the future.')
    expect(sanitizeScheduledTaskForSave(baseTask).runAt).toEqual(baseTask.runAt)
  })

  it('stages scheduled attachments only after workspace and grant normalization', () => {
    const events: string[] = []
    const stageScheduledAttachments = vi.fn(({ attachments }) => {
      events.push('stage')
      return {
        ok: true as const,
        attachments: attachments.map((attachment) => ({
          persistenceVersion: 1 as const,
          path: `/tmp/taskwraith-assets/${attachment.id}.png`,
          sha256: 'b'.repeat(43),
          mimeType: 'image/png',
          byteLength: 12
        }))
      }
    })
    const { sanitizeScheduledTaskForSave } = createMainSanitizers({
      getSettings: () => makeSettings(),
      getScheduledTasks: () => [],
      getWorkflowDefinitions: () => [],
      getChat: (id) => (id === 'chat-1' ? workspaceChat('/canonical/workspace') : null),
      findRegisteredWorkspace: () => ({
        id: 'workspace-1',
        path: '/canonical/workspace',
        displayName: 'Workspace',
        lastOpenedAt: 1,
        createdAt: 1,
        pinned: false
      }),
      requireRegisteredWorkspace: (workspacePath: string) => workspacePath,
      canonicalPath: (value: string) => {
        events.push('canonical')
        return value
      },
      normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => {
        events.push('grants')
        return grants
      },
      stageScheduledAttachments
    })

    const saved = sanitizeScheduledTaskForSave({
      workspaceId: 'workspace-1',
      workspacePath: '/canonical/workspace',
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Run later',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [{ id: 'image-1', name: 'proof.png', path: '/fresh/proof.png' }],
      runAt: new Date(Date.now() + 60_000).toISOString(),
      timezone: 'Europe/London'
    })

    expect(events).toEqual(['canonical', 'canonical', 'grants', 'stage'])
    expect(stageScheduledAttachments).toHaveBeenCalledWith({
      appChatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/canonical/workspace',
      externalPathGrants: [],
      attachments: [{ id: 'image-1', name: 'proof.png', path: '/fresh/proof.png' }]
    })
    expect(saved.imageAttachments).toEqual([
      {
        persistenceVersion: 1,
        id: 'image-1',
        path: '/tmp/taskwraith-assets/image-1.png',
        name: 'proof.png',
        sha256: 'b'.repeat(43),
        mimeType: 'image/png',
        byteLength: 12
      }
    ])
  })

  it('requires attachment identity and surfaces re-selection guidance when staging fails', () => {
    const stageScheduledAttachments = vi.fn(() => ({
      ok: false as const,
      reason: 'missing'
    }))
    const sanitizer = createMainSanitizers({
      getSettings: () => makeSettings(),
      getScheduledTasks: () => [],
      getWorkflowDefinitions: () => [],
      getChat: (id) => (id === 'chat-1' ? workspaceChat() : null),
      findRegisteredWorkspace: () => ({
        id: 'workspace-1',
        path: '/tmp/taskwraith-workspace',
        displayName: 'Workspace',
        lastOpenedAt: 1,
        createdAt: 1,
        pinned: false
      }),
      requireRegisteredWorkspace: (workspacePath: string) => workspacePath,
      canonicalPath: (value: string) => value,
      normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => grants,
      stageScheduledAttachments
    })
    const baseTask = {
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace',
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Run later',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      runAt: new Date(Date.now() + 60_000).toISOString(),
      timezone: 'Europe/London'
    }

    expect(() =>
      sanitizer.sanitizeScheduledTaskForSave({
        ...baseTask,
        imageAttachments: [{ id: '', name: 'proof.png', path: '/fresh/proof.png' }]
      })
    ).toThrow('Workflow attachments 1 id is required.')
    expect(() =>
      sanitizer.sanitizeScheduledTaskForSave({
        ...baseTask,
        imageAttachments: [{ id: 'image-1', name: 'proof.png', path: '/fresh/proof.png' }]
      })
    ).toThrow('Re-select the attachments')

    stageScheduledAttachments.mockClear()
    expect(() =>
      sanitizer.sanitizeScheduledTaskForSave({
        ...baseTask,
        imageAttachments: Array.from({ length: MAX_DURABLE_ATTACHMENT_REFS + 1 }, (_, index) => ({
          id: `image-${index}`,
          name: `proof-${index}.png`,
          path: `/fresh/proof-${index}.png`
        }))
      })
    ).toThrow('Re-select the attachments')
    expect(stageScheduledAttachments).not.toHaveBeenCalled()
  })

  it('rejects a missing, archived, global, or moved chat before staging attachments', () => {
    const stageScheduledAttachments = vi.fn()
    const baseTask = {
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace',
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Run later',
      imageAttachments: [{ id: 'image-1', name: 'proof.png', path: '/fresh/proof.png' }],
      runAt: new Date(Date.now() + 60_000).toISOString(),
      timezone: 'Europe/London'
    }
    const invalidChats = [
      null,
      { ...workspaceChat(), archived: true },
      { ...workspaceChat(), scope: 'global' as const },
      { ...workspaceChat(), workspacePath: '/other-workspace' }
    ]

    for (const chat of invalidChats) {
      const { sanitizeScheduledTaskForSave } = makeSanitizers(makeSettings(), {
        getChat: () => chat,
        stageScheduledAttachments
      })
      expect(() => sanitizeScheduledTaskForSave(baseTask)).toThrow(
        'Scheduled task chat must be a live chat in the selected workspace.'
      )
    }
    expect(stageScheduledAttachments).not.toHaveBeenCalled()
  })

  it('rejects renderer attempts to patch scheduled task configuration or authority', () => {
    const existing = {
      id: 'task-1',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace',
      chatId: 'chat-1',
      provider: 'codex' as const,
      prompt: 'Run later',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      externalPathGrants: [],
      runAt: new Date(Date.now() + 60_000).toISOString(),
      timezone: 'Europe/London',
      status: 'pending' as const,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z'
    }
    const stageScheduledAttachments = vi.fn()
    const { sanitizeScheduledTaskPatch } = createMainSanitizers({
      getSettings: () => makeSettings(),
      getScheduledTasks: () => [existing],
      getWorkflowDefinitions: () => [],
      getChat: (id) => (id === 'chat-1' ? workspaceChat() : null),
      findRegisteredWorkspace: () => ({
        id: 'workspace-1',
        path: '/tmp/taskwraith-workspace',
        displayName: 'Workspace',
        lastOpenedAt: 1,
        createdAt: 1,
        pinned: false
      }),
      requireRegisteredWorkspace: (workspacePath: string) => workspacePath,
      canonicalPath: (value: string) => value,
      normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => grants,
      stageScheduledAttachments
    })

    for (const patch of [
      { prompt: 'Forged prompt' },
      { provider: 'claude' },
      { approvalMode: 'full_access' },
      { sessionTrust: true },
      { workflowId: 'elevated-workflow' },
      { imageAttachments: [{ id: 'image-1', name: 'proof.png', path: '/external/proof.png' }] }
    ]) {
      expect(() => sanitizeScheduledTaskPatch('task-1', patch)).toThrow(
        'Scheduled task configuration and workflow linkage are main-owned.'
      )
    }
    expect(stageScheduledAttachments).not.toHaveBeenCalled()
  })

  it('persists workflow-template attachments with stable non-empty identity', () => {
    const { sanitizeWorkflowForSave } = makeSanitizers(makeSettings())
    const saved = sanitizeWorkflowForSave({
      name: 'Daily review',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace',
      enabled: true,
      trigger: { kind: 'manual' },
      template: {
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/taskwraith-workspace',
        chatId: 'chat-1',
        provider: 'codex',
        prompt: 'Review the project.',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: [
          { id: 'workflow-image', name: 'workflow.png', path: '/fresh/workflow.png' }
        ]
      },
      missedRunPolicy: 'coalesce',
      concurrencyPolicy: 'skip',
      limits: {}
    })

    expect(saved.template.imageAttachments).toEqual([
      {
        persistenceVersion: 1,
        id: 'workflow-image',
        path: '/tmp/taskwraith-assets/workflow-image.png',
        name: 'workflow.png',
        sha256: 'a'.repeat(43),
        mimeType: 'image/png',
        byteLength: 8
      }
    ])
  })

  it('allows only configurable workflow-template fields from renderer input', () => {
    const { sanitizeWorkflowForSave } = makeSanitizers(makeSettings())
    const saved = sanitizeWorkflowForSave({
      name: 'Safe workflow template',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace',
      enabled: true,
      trigger: { kind: 'manual' },
      template: {
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/taskwraith-workspace',
        chatId: 'chat-1',
        provider: 'codex',
        prompt: 'Review the project.',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'plan',
        permissionPresetId: 'read_only',
        workflowMode: 'plan',
        claudeReasoningEffort: 'high',
        sessionTrust: false,
        imageAttachments: [],
        id: 'victim-task',
        runAt: '1999-01-01T00:00:00.000Z',
        timezone: 'forged-zone',
        status: 'completed',
        createdAt: '1999-01-01T00:00:00.000Z',
        updatedAt: '1999-01-01T00:00:00.000Z',
        runId: 'victim-run',
        permissionPosture: { signaturePresent: true },
        dispatchReceipt: { runId: 'victim-run' },
        firedAt: '1999-01-01T00:00:00.000Z',
        runningSince: '1999-01-01T00:00:00.000Z',
        completedAt: '1999-01-01T00:00:00.000Z',
        lastError: 'forged failure',
        workflowId: 'forged-workflow',
        workflowExecutionId: 'forged-execution',
        workflowOccurrenceAt: '1999-01-01T00:00:00.000Z',
        futureAuthorityField: 'must not survive'
      },
      missedRunPolicy: 'coalesce',
      concurrencyPolicy: 'skip',
      limits: {}
    })

    expect(saved.template).toMatchObject({
      permissionPresetId: 'read_only',
      workflowMode: 'plan',
      claudeReasoningEffort: 'high'
    })
    for (const field of [
      'id',
      'runAt',
      'timezone',
      'status',
      'createdAt',
      'updatedAt',
      'runId',
      'permissionPosture',
      'dispatchReceipt',
      'firedAt',
      'runningSince',
      'completedAt',
      'lastError',
      'workflowId',
      'workflowExecutionId',
      'workflowOccurrenceAt',
      'futureAuthorityField'
    ]) {
      expect(saved.template).not.toHaveProperty(field)
    }
  })

  it('makes renderer workflow save create-only and permits only enabled/trigger updates', () => {
    const fixedNow = '2026-07-14T12:00:00.000Z'
    const draft = {
      name: 'Safe workflow',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace',
      enabled: true,
      trigger: { kind: 'manual' as const },
      template: {
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/taskwraith-workspace',
        chatId: 'chat-1',
        provider: 'codex' as const,
        prompt: 'Review the project.',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: []
      },
      missedRunPolicy: 'coalesce' as const,
      concurrencyPolicy: 'skip' as const,
      limits: {}
    }
    const initial = makeSanitizers(makeSettings()).sanitizeWorkflowForSave(draft)
    expect(initial.template.workflowMode).toBe('normal')
    const victim = {
      ...initial,
      id: 'victim-workflow',
      failureStreak: 0,
      history: [],
      createdAt: fixedNow,
      updatedAt: fixedNow
    } as any
    const sanitizer = makeSanitizers(makeSettings(), {
      getWorkflowDefinitions: () => [victim]
    })

    expect(() => sanitizer.sanitizeWorkflowForSave({ ...draft, id: 'victim-workflow' })).toThrow(
      'Workflow creation cannot replace an existing workflow.'
    )
    expect(sanitizer.sanitizeWorkflowPatch(victim.id, { enabled: false })).toEqual({
      enabled: false,
      unattendedElevation: undefined
    })
    expect(
      sanitizer.sanitizeWorkflowPatch(victim.id, {
        trigger: { kind: 'interval', intervalMs: 120_000, startAt: fixedNow }
      })
    ).toEqual({
      trigger: {
        kind: 'interval',
        intervalMs: 120_000,
        startAt: fixedNow,
        timezone: undefined
      },
      unattendedElevation: undefined
    })

    for (const patch of [
      { id: 'other-workflow' },
      { workspaceId: 'workspace-2' },
      { template: { ...victim.template, prompt: 'Retargeted prompt.' } },
      { unattendedElevation: { level: 'full_access' } },
      { history: [] },
      { limits: { maxRunsPerDay: 1000 } }
    ]) {
      expect(() => sanitizer.sanitizeWorkflowPatch(victim.id, patch)).toThrow(
        'Workflow configuration and authority are main-owned after creation.'
      )
    }
  })

  it('strips renderer-supplied scheduled identity, lifecycle, linkage, and posture', () => {
    const { sanitizeScheduledTaskForSave, sanitizeScheduledTaskPatch } =
      makeSanitizers(makeSettings())
    const runAt = new Date(Date.now() + 60_000).toISOString()
    const baseTask = {
      id: 'task-1',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace',
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Run later',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: true,
      imageAttachments: [],
      runAt,
      timezone: 'Europe/London',
      status: 'due',
      runId: 'forged-run',
      workflowId: 'forged-workflow',
      workflowExecutionId: 'forged-execution',
      workflowOccurrenceAt: runAt,
      dispatchReceipt: { permissionPostureSignaturePresent: true },
      permissionPosture: { signaturePresent: true }
    }

    const saved = sanitizeScheduledTaskForSave(baseTask)
    expect(saved.sessionTrust).toBe(false)
    for (const field of [
      'id',
      'status',
      'runId',
      'workflowId',
      'workflowExecutionId',
      'workflowOccurrenceAt',
      'dispatchReceipt',
      'permissionPosture'
    ]) {
      expect(saved).not.toHaveProperty(field)
    }

    const { sanitizeScheduledTaskPatch: sanitizePatchWithExisting } = createMainSanitizers({
      getSettings: () => makeSettings(),
      getScheduledTasks: () => [
        {
          ...baseTask,
          id: 'task-1',
          status: 'pending',
          createdAt: runAt,
          updatedAt: runAt
        } as any
      ],
      getWorkflowDefinitions: () => [],
      getChat: (id) => (id === 'chat-1' ? workspaceChat() : null),
      findRegisteredWorkspace: (workspacePath: string) =>
        workspacePath === '/tmp/taskwraith-workspace'
          ? {
              id: 'workspace-1',
              path: '/tmp/taskwraith-workspace',
              displayName: 'Workspace',
              lastOpenedAt: 1,
              createdAt: 1,
              pinned: false
            }
          : undefined,
      requireRegisteredWorkspace: (workspacePath: string) => workspacePath,
      canonicalPath: (value: string) => value,
      normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => grants,
      stageScheduledAttachments: ({ attachments }) => ({
        ok: true,
        attachments: attachments.map((attachment) => ({
          persistenceVersion: 1,
          id: attachment.id,
          path: `/tmp/taskwraith-assets/${attachment.id}.png`,
          name: attachment.name,
          sha256: 'a'.repeat(43),
          mimeType: 'image/png',
          byteLength: 8
        }))
      })
    })
    expect(sanitizeScheduledTaskPatch('missing', {})).toBeNull()
    expect(() =>
      sanitizePatchWithExisting('task-1', {
        status: 'cancelled',
        dispatchReceipt: { permissionPostureSignaturePresent: true }
      })
    ).toThrow('Scheduled task configuration and workflow linkage are main-owned.')
  })
})

describe('MainSanitizers workspace boards', () => {
  it('sanitizes board and card provenance metadata', () => {
    const { sanitizeWorkspaceBoardForSave, sanitizeWorkspaceBoardCardForSave } =
      makeSanitizers(makeSettings())
    const provenance = {
      actor: 'agent',
      sourceKind: 'goal',
      at: '2026-06-29T00:00:00.000Z',
      trust: 'agent-proposed',
      sourceId: 'goal-1',
      sourceTitle: 'Launch plan',
      provider: 'codex',
      runId: 'run-1',
      note: 'Generated from goal'
    }

    expect(
      sanitizeWorkspaceBoardForSave({
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/taskwraith-workspace',
        name: 'Goal board',
        columns: [],
        provenance
      }).provenance
    ).toEqual(provenance)

    expect(
      sanitizeWorkspaceBoardCardForSave({
        boardId: 'board-1',
        workspaceId: 'workspace-1',
        columnId: 'ready',
        title: 'Review',
        provenance: {
          actor: 'unknown',
          sourceKind: 'surprise',
          trust: 'nope',
          sourceTitle: '  Captured  '
        }
      }).provenance
    ).toMatchObject({
      actor: 'user',
      sourceKind: 'manual',
      sourceTitle: 'Captured'
    })
  })

  it('rejects unknown workspace board card link kinds at the IPC sanitizer boundary', () => {
    const { sanitizeWorkspaceBoardCardForSave, sanitizeWorkspaceBoardCardPatch } =
      makeSanitizers(makeSettings())

    expect(() =>
      sanitizeWorkspaceBoardCardForSave({
        boardId: 'board-1',
        workspaceId: 'workspace-1',
        columnId: 'ready',
        title: 'Bad link',
        link: { kind: 'bogus', id: 'target-1' }
      })
    ).toThrow('Workspace board card link kind is invalid.')

    expect(() =>
      sanitizeWorkspaceBoardCardPatch({
        link: { kind: 'bogus', id: 'target-1' }
      })
    ).toThrow('Workspace board card link kind is invalid.')
  })

  it('preserves precise workspace board card sort orders through IPC sanitization', () => {
    const { sanitizeWorkspaceBoardCardForSave, sanitizeWorkspaceBoardCardPatch } =
      makeSanitizers(makeSettings())

    expect(
      sanitizeWorkspaceBoardCardForSave({
        boardId: 'board-1',
        workspaceId: 'workspace-1',
        columnId: 'ready',
        title: 'Precise order',
        sortOrder: 1024.5
      }).sortOrder
    ).toBe(1024.5)

    expect(sanitizeWorkspaceBoardCardPatch({ sortOrder: -1014 }).sortOrder).toBe(-1014)
  })
})

describe('MainSanitizers settings patches', () => {
  afterEach(() => {
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
  })

  it('preserves a wide dragged inspector width instead of re-clamping it at persistence', () => {
    const { sanitizeSettingsPatch } = makeSanitizers(makeSettings())
    // A canvas-wide dock (Mesh scenes, desktop-style Browser work) must survive
    // the settings round-trip: a sanitizer ceiling below the renderer's resize
    // max silently snapped every wide drag back on the next hydrate.
    expect(sanitizeSettingsPatch({ inspectorWidth: 2000 }).inspectorWidth).toBe(2000)
    expect(sanitizeSettingsPatch({ inspectorWidth: 9000 }).inspectorWidth).toBe(
      MAX_INSPECTOR_WIDTH
    )
    expect(sanitizeSettingsPatch({ inspectorWidth: 50 }).inspectorWidth).toBe(MIN_INSPECTOR_WIDTH)
  })

  it('preserves active AntiGravity through either admitted settings lane', () => {
    const { sanitizeSettingsPatch } = makeSanitizers(makeSettings({ activeProvider: 'claude' }))

    expect(
      sanitizeSettingsPatch({
        activeProvider: 'antigravity',
        antigravityEnabled: true,
        antigravityOptInAcceptedAt: 1_700_000_000_000
      }).activeProvider
    ).toBe('antigravity')

    setAntigravityGeminiApiKeyConfiguredProbe(() => true)
    expect(sanitizeSettingsPatch({ activeProvider: 'antigravity' }).activeProvider).toBe(
      'antigravity'
    )
  })

  it('fails closed for walled AntiGravity and historical Gemini active selections', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => false)
    const { sanitizeSettingsPatch } = makeSanitizers(makeSettings({ activeProvider: 'claude' }))

    expect(sanitizeSettingsPatch({ activeProvider: 'antigravity' }).activeProvider).toBe('claude')
    expect(sanitizeSettingsPatch({ activeProvider: 'gemini' }).activeProvider).toBe('claude')
  })

  it('preserves General dashboard, heatmap, and approval timeout preferences', () => {
    const settings = makeSettings({
      dashboardStatPrefs: {
        visibility: {
          sessions: false
        },
        workspacesShown: 8
      },
      welcomeHeatmapPrefs: {
        layout: 'stacked',
        workspaceActivityEnabled: true,
        taskwraithActivityEnabled: true,
        externalActivityEnabled: true
      }
    })
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    const sanitized = sanitizeSettingsPatch({
      dashboardStatPrefs: {
        dashboardEnabled: false,
        dashboardSize: 'small'
      },
      welcomeHeatmapPrefs: {
        layout: 'single',
        workspaceActivityEnabled: false
      },
      approvalTimeouts: {
        enabled: false,
        perProviderMs: {
          gemini: 240_000,
          grok: 75_000
        },
        mainAuthorityMs: 0
      }
    })

    expect(sanitized.dashboardStatPrefs).toMatchObject({
      dashboardEnabled: false,
      dashboardSize: 'small',
      visibility: {
        sessions: false
      },
      workspacesShown: 8
    })
    expect(sanitized.welcomeHeatmapPrefs).toMatchObject({
      layout: 'single',
      workspaceActivityEnabled: false,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true
    })
    expect(sanitized.approvalTimeouts).toMatchObject({
      enabled: false,
      defaultsVersion: 2,
      perProviderMs: {
        gemini: 240_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000,
        grok: 75_000,
        cursor: 120_000,
        ollama: 120_000
      },
      mainAuthorityMs: 60_000
    })
  })

  it('accepts a valid modelUsagePanelView and drops invalid values', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ modelUsagePanelView: 'spend' }).modelUsagePanelView).toBe(
      'spend'
    )
    expect(sanitizeSettingsPatch({ modelUsagePanelView: 'plan' }).modelUsagePanelView).toBe('plan')
    expect(sanitizeSettingsPatch({ modelUsagePanelView: 'context' }).modelUsagePanelView).toBe(
      'context'
    )
    // Anything outside the enum is stripped so a malformed value can't persist.
    expect(
      'modelUsagePanelView' in
        sanitizeSettingsPatch({ modelUsagePanelView: 'bogus' as unknown as 'plan' })
    ).toBe(false)
  })

  it('persists an explicit Pi/Cerebras completion cap and permits an explicit reset', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({ piCerebrasMaxCompletionTokens: 16_384 }).piCerebrasMaxCompletionTokens
    ).toBe(16_384)
    expect(
      sanitizeSettingsPatch({ piCerebrasMaxCompletionTokens: null }).piCerebrasMaxCompletionTokens
    ).toBeUndefined()
    expect(
      'piCerebrasMaxCompletionTokens' in
        sanitizeSettingsPatch({ piCerebrasMaxCompletionTokens: 40_961 })
    ).toBe(false)
  })

  it('persists only normalized non-secret API usage billing readings', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({
        apiUsageBilling: {
          deepseek: { totalTopUp: 10, apiKey: 'must-not-persist' },
          cerebras: { purchasedCredits: 20, currentBalance: 7.5, currency: 'gbp' },
          meta: {
            spent: 0.05,
            currency: 'eur',
            resetAt: '2026-09-01',
            anchorUpdatedAt: '2026-08-15T12:00:00Z'
          }
        } as unknown as AppSettings['apiUsageBilling']
      }).apiUsageBilling
    ).toEqual({
      deepseek: { totalTopUp: 10 },
      cerebras: { purchasedCredits: 20, currentBalance: 7.5, currency: 'GBP' },
      meta: {
        spent: 0.05,
        currency: 'EUR',
        resetAt: '2026-09-01T00:00:00.000Z',
        anchorUpdatedAt: '2026-08-15T12:00:00.000Z'
      }
    })
    expect(sanitizeSettingsPatch({ apiUsageBilling: null }).apiUsageBilling).toBeUndefined()
  })

  it('persists a valid appIconVariant and drops invalid ones (SETTINGS_PATCH_KEYS guard)', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    // Guards the landmine: appIconVariant must be in SETTINGS_PATCH_KEYS or the
    // whole key is silently dropped before it can persist.
    expect(sanitizeSettingsPatch({ appIconVariant: 'monoline' }).appIconVariant).toBe('monoline')
    expect(sanitizeSettingsPatch({ appIconVariant: 'regular' }).appIconVariant).toBe('regular')
    expect(sanitizeSettingsPatch({ appIconVariant: 'lightMonoline' }).appIconVariant).toBe(
      'lightMonoline'
    )
    expect(
      'appIconVariant' in sanitizeSettingsPatch({ appIconVariant: 'bogus' as unknown as 'regular' })
    ).toBe(false)
  })

  it('persists and clamps maxWaveAgents (SETTINGS_PATCH_KEYS guard)', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ maxWaveAgents: 8 }).maxWaveAgents).toBe(8)
    expect(sanitizeSettingsPatch({ maxWaveAgents: 1 }).maxWaveAgents).toBe(2)
    expect(sanitizeSettingsPatch({ maxWaveAgents: 99 }).maxWaveAgents).toBe(64)
    expect(sanitizeSettingsPatch({ maxWaveAgents: 8.9 }).maxWaveAgents).toBe(8)
    expect(
      'maxWaveAgents' in sanitizeSettingsPatch({ maxWaveAgents: 'nope' as unknown as number })
    ).toBe(false)
  })

  it('persists and normalizes cliPathDirectories (SETTINGS_PATCH_KEYS guard)', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    // Guards the landmine: cliPathDirectories must be in SETTINGS_PATCH_KEYS or
    // the key is dropped before persist and the setting silently never applies.
    expect(
      sanitizeSettingsPatch({ cliPathDirectories: [' /opt/homebrew/bin ', '~/.local/bin'] })
        .cliPathDirectories
    ).toEqual(['/opt/homebrew/bin', '~/.local/bin'])
  })

  it('persists the Simulator control switch and drops malformed values', () => {
    const { sanitizeSettingsPatch } = makeSanitizers(makeSettings())
    expect(sanitizeSettingsPatch({ simulatorControlEnabled: false }).simulatorControlEnabled).toBe(
      false
    )
    expect(
      'simulatorControlEnabled' in
        sanitizeSettingsPatch({ simulatorControlEnabled: 'nope' as unknown as boolean })
    ).toBe(false)
  })

  it('refuses relative and control-character entries in cliPathDirectories', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    // These directories are searched FIRST for every external CLI, so an
    // unvalidated patch here would be a binary-planting primitive.
    expect(
      sanitizeSettingsPatch({
        cliPathDirectories: ['relative/bin', '/opt/ok/bin', '/evil\nrm -rf /', '']
      }).cliPathDirectories
    ).toEqual(['/opt/ok/bin'])
    expect(
      sanitizeSettingsPatch({ cliPathDirectories: 'not-an-array' as unknown as string[] })
        .cliPathDirectories
    ).toEqual([])
  })

  it('drops the retired wwdc26 variant and other invalid app-icon ids', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ appIconVariant: 'monoline' }).appIconVariant).toBe('monoline')
    expect('appIconVariant' in sanitizeSettingsPatch({ appIconVariant: 'wwdc26' })).toBe(false)
    expect('appIconVariant' in sanitizeSettingsPatch({ appIconVariant: 'nope' })).toBe(false)
  })

  it('persists toolIconAccent and userBubbleColor (regression: both were missing from the allowlist)', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ toolIconAccent: 'cyan' }).toolIconAccent).toBe('cyan')
    expect(sanitizeSettingsPatch({ userBubbleColor: 'green' }).userBubbleColor).toBe('green')
  })

  it('persists a canonical shared theme accent color', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ themeAccentColor: '#12ab34' }).themeAccentColor).toBe('#12AB34')
    expect(sanitizeSettingsPatch({ themeAccentColor: 'f0c' }).themeAccentColor).toBe('#FF00CC')
    expect(sanitizeSettingsPatch({ themeAccentColor: 'not-a-colour' }).themeAccentColor).toBe(
      '#5A8CFF'
    )
  })

  it('persists diffStatColors (regression: dropped by the allowlist, so it never survived a restart)', () => {
    // Same class as toolIconAccent/userBubbleColor above. `useAppearance` sent
    // diffStatColors in every appearance patch and `rendererAppearanceSettings`
    // read it back, but the key was absent from SETTINGS_PATCH_KEYS — so the
    // sanitizer dropped it silently and the chosen colours were live-only.
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    const result = sanitizeSettingsPatch({
      diffStatColors: { additions: '#123456', deletions: '#abcdef' }
    })
    expect(result.diffStatColors).toEqual({ additions: '#123456', deletions: '#ABCDEF' })
  })

  it('normalizes diffStatColors on WRITE so junk never reaches disk', () => {
    // The allowlist alone would let an arbitrary object through; the store only
    // normalized on read. Shorthand expands, case is canonicalised, and invalid
    // or missing channels fall back rather than persisting garbage — which also
    // makes this seam safe for an agent-driven token write later.
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(
      sanitizeSettingsPatch({ diffStatColors: { additions: 'f00', deletions: 'nonsense' } })
        .diffStatColors
    ).toEqual({ additions: '#FF0000', deletions: '#EC3D35' })
    expect(sanitizeSettingsPatch({ diffStatColors: 'not-an-object' }).diffStatColors).toEqual({
      additions: '#2DB777',
      deletions: '#EC3D35'
    })
  })

  it('persists+coerces the AntiGravity opt-in fields (SETTINGS_PATCH_KEYS guard)', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    // Boolean coercion, and the consent timestamp survives round-trip.
    expect(sanitizeSettingsPatch({ antigravityEnabled: true }).antigravityEnabled).toBe(true)
    expect(sanitizeSettingsPatch({ antigravityEnabled: false }).antigravityEnabled).toBe(false)
    expect(
      sanitizeSettingsPatch({ antigravityOptInAcceptedAt: 1_700_000_000_000 })
        .antigravityOptInAcceptedAt
    ).toBe(1_700_000_000_000)
    // A non-positive / non-numeric consent timestamp normalizes to null (no consent).
    expect(
      sanitizeSettingsPatch({ antigravityOptInAcceptedAt: 0 }).antigravityOptInAcceptedAt
    ).toBe(null)
    expect(
      sanitizeSettingsPatch({
        antigravityOptInAcceptedAt: 'yes' as unknown as number
      }).antigravityOptInAcceptedAt
    ).toBe(null)
  })

  it('persists only a finite positive Gemini API disclosure timestamp', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(
      sanitizeSettingsPatch({
        antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_000
      }).antigravityGeminiApiDisclosureAcceptedAt
    ).toBe(1_700_000_000_000)
    expect(
      sanitizeSettingsPatch({ antigravityGeminiApiDisclosureAcceptedAt: null })
        .antigravityGeminiApiDisclosureAcceptedAt
    ).toBe(null)
    for (const value of [0, -1, Infinity, NaN, 'yes'] as unknown[]) {
      expect(
        sanitizeSettingsPatch({
          antigravityGeminiApiDisclosureAcceptedAt: value as number
        }).antigravityGeminiApiDisclosureAcceptedAt
      ).toBe(null)
    }
  })

  it('clamps the Gemini API monthly spend cap to a bounded positive USD amount', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(
      sanitizeSettingsPatch({ antigravityGeminiApiMonthlySpendCapUsd: 20 })
        .antigravityGeminiApiMonthlySpendCapUsd
    ).toBe(20)
    expect(
      sanitizeSettingsPatch({ antigravityGeminiApiMonthlySpendCapUsd: null })
        .antigravityGeminiApiMonthlySpendCapUsd
    ).toBe(null)
    // Zero, negatives, non-numbers, infinities and absurd values all clear the
    // cap rather than persisting a meter that lies or never fills.
    for (const value of [0, -5, Infinity, NaN, 'lots', 1_000_001] as unknown[]) {
      expect(
        sanitizeSettingsPatch({
          antigravityGeminiApiMonthlySpendCapUsd: value as number
        }).antigravityGeminiApiMonthlySpendCapUsd
      ).toBe(null)
    }
  })

  it('clamps the Muse monthly spend cap to a bounded positive USD amount', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ museMonthlySpendCapUsd: 15 }).museMonthlySpendCapUsd).toBe(15)
    expect(sanitizeSettingsPatch({ museMonthlySpendCapUsd: null }).museMonthlySpendCapUsd).toBe(
      null
    )
    for (const value of [0, -5, Infinity, NaN, 'lots', 1_000_001] as unknown[]) {
      expect(
        sanitizeSettingsPatch({ museMonthlySpendCapUsd: value as number }).museMonthlySpendCapUsd
      ).toBe(null)
    }
  })

  it('accepts a boolean modelUsageExternalUsage and drops non-boolean values', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ modelUsageExternalUsage: true }).modelUsageExternalUsage).toBe(
      true
    )
    expect(sanitizeSettingsPatch({ modelUsageExternalUsage: false }).modelUsageExternalUsage).toBe(
      false
    )
    // A non-boolean (e.g. a stray string) is stripped so it can't persist.
    expect(
      'modelUsageExternalUsage' in
        sanitizeSettingsPatch({
          modelUsageExternalUsage: 'yes' as unknown as boolean
        })
    ).toBe(false)
  })

  it('persists and normalizes prompt cache settings', () => {
    const settings = makeSettings({
      promptCache: {
        enabled: true,
        providers: {
          claude: { mode: 'auto' },
          kimi: { mode: 'off' }
        }
      }
    })
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({
        promptCache: {
          enabled: false,
          providers: {
            claude: { mode: 'explicit', minStablePrefixTokens: 2048.5 },
            kimi: { mode: 'bogus' as 'auto' }
          }
        }
      }).promptCache
    ).toMatchObject({
      enabled: false,
      providers: {
        claude: { mode: 'explicit', minStablePrefixTokens: 2048 },
        kimi: { mode: 'off' }
      }
    })
  })

  it('accepts only an explicit boolean trustWorkspaceHooks preference', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(sanitizeSettingsPatch({ trustWorkspaceHooks: true }).trustWorkspaceHooks).toBe(true)
    expect(sanitizeSettingsPatch({ trustWorkspaceHooks: false }).trustWorkspaceHooks).toBe(false)
    for (const value of [undefined, null, 'true', 1, {}]) {
      expect(
        'trustWorkspaceHooks' in sanitizeSettingsPatch({ trustWorkspaceHooks: value as boolean })
      ).toBe(false)
    }
  })

  it('accepts only an explicit boolean askBeforeHookCommands preference', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(sanitizeSettingsPatch({ askBeforeHookCommands: true }).askBeforeHookCommands).toBe(true)
    expect(sanitizeSettingsPatch({ askBeforeHookCommands: false }).askBeforeHookCommands).toBe(
      false
    )
    for (const value of [undefined, null, 'true', 1, {}]) {
      expect(
        'askBeforeHookCommands' in
          sanitizeSettingsPatch({ askBeforeHookCommands: value as boolean })
      ).toBe(false)
    }
  })

  it('preserves the General auto-update checkbox setting', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(sanitizeSettingsPatch({ autoUpdateEnabled: false }).autoUpdateEnabled).toBe(false)
    expect(sanitizeSettingsPatch({ autoUpdateEnabled: true }).autoUpdateEnabled).toBe(true)
    for (const value of [undefined, null, 'false', 0, {}]) {
      expect('autoUpdateEnabled' in sanitizeSettingsPatch({ autoUpdateEnabled: value })).toBe(false)
    }
  })

  it('accepts only an explicit boolean activity-reporting preference', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({ activityReportingEnabled: false }).activityReportingEnabled
    ).toBe(false)
    expect(sanitizeSettingsPatch({ activityReportingEnabled: true }).activityReportingEnabled).toBe(
      true
    )
    for (const value of [undefined, null, 'true', 1, {}]) {
      expect(
        'activityReportingEnabled' in sanitizeSettingsPatch({ activityReportingEnabled: value })
      ).toBe(false)
    }
  })

  it('sanitizes the local-servers lifecycle toggles', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    const sanitized = sanitizeSettingsPatch({
      localServersDetachSpawns: true,
      localServersStopOnQuit: true
    })
    expect(sanitized.localServersDetachSpawns).toBe(true)
    expect(sanitized.localServersStopOnQuit).toBe(true)
    // Non-booleans coerce to real booleans.
    const coerced = sanitizeSettingsPatch({
      localServersDetachSpawns: 1 as unknown as boolean,
      localServersStopOnQuit: 0 as unknown as boolean
    })
    expect(coerced.localServersDetachSpawns).toBe(true)
    expect(coerced.localServersStopOnQuit).toBe(false)
  })

  it('sanitizes user-managed MCP server settings', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    const sanitized = sanitizeSettingsPatch({
      userMcpServers: [
        {
          id: 'server-1',
          name: ' filesystem ',
          enabled: true,
          transport: 'stdio',
          command: ' npx ',
          args: [' @modelcontextprotocol/server-filesystem ', '', 5],
          env: {
            PROJECT_ROOT: '/repo',
            OPENAI_API_KEY: 'sk-1234567890abcdefghijklmnop',
            SAFE_TOKEN_REF: '${SAFE_TOKEN_REF}',
            'bad-key': 'drop'
          },
          secretRefs: {
            env: ['FILESYSTEM_TOKEN', 'bad-env-name', 'FILESYSTEM_TOKEN'],
            headers: ['unused-header']
          },
          description: ' Local files ',
          pluginProvenance: {
            pluginId: 'demo-bundle',
            publisher: 'acme',
            version: '1.0.0',
            source: 'builtin',
            namespace: 'plugin.acme.demo-bundle',
            manifestHash: 'abc123',
            kind: 'mcpServer',
            objectId: 'filesystem',
            materializedAt: '2026-06-29T12:00:00.000Z'
          },
          pluginReview: {
            status: 'accepted',
            reason: 'user-enabled-reviewed-resource',
            manifestHash: 'abc123',
            reviewedAt: '2026-06-29T12:05:00.000Z'
          }
        },
        {
          id: 'server-1',
          name: 'duplicate'
        },
        {
          id: 'server-2',
          name: ' docs ',
          enabled: true,
          transport: 'http',
          url: ' https://example.test/mcp ',
          headers: {
            Authorization: 'Bearer ${DOCS_TOKEN}',
            'X-API-Key': 'inline-secret-key',
            'X-Auth-Token': '$AUTH_TOKEN',
            'X-Figma-Region': 'eu',
            'bad header': 'drop'
          },
          secretRefs: {
            env: ['DOCS_TOKEN'],
            headers: ['X-API-Key', 'bad header', 'X-API-Key']
          },
          bearerTokenEnvVar: ' DOCS_TOKEN '
        },
        {
          id: 'server-3',
          name: ' bad remote ',
          enabled: true,
          transport: 'http',
          url: ' ftp://example.test/mcp '
        },
        {
          id: '',
          name: 'missing id'
        }
      ]
    })

    expect(sanitized.userMcpServers).toEqual([
      {
        id: 'server-1',
        name: 'filesystem',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem'],
        env: {
          PROJECT_ROOT: '/repo',
          SAFE_TOKEN_REF: '${SAFE_TOKEN_REF}'
        },
        secretRefs: {
          env: ['FILESYSTEM_TOKEN'],
          headers: ['unused-header']
        },
        description: 'Local files',
        pluginProvenance: {
          pluginId: 'demo-bundle',
          publisher: 'acme',
          version: '1.0.0',
          source: 'builtin',
          namespace: 'plugin.acme.demo-bundle',
          manifestHash: 'abc123',
          kind: 'mcpServer',
          objectId: 'filesystem',
          materializedAt: '2026-06-29T12:00:00.000Z'
        },
        pluginReview: {
          status: 'accepted',
          reason: 'user-enabled-reviewed-resource',
          manifestHash: 'abc123',
          reviewedAt: '2026-06-29T12:05:00.000Z'
        }
      },
      {
        id: 'server-2',
        name: 'docs',
        enabled: true,
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: {
          Authorization: 'Bearer ${DOCS_TOKEN}',
          'X-Auth-Token': '$AUTH_TOKEN',
          'X-Figma-Region': 'eu'
        },
        secretRefs: {
          env: ['DOCS_TOKEN'],
          headers: ['X-API-Key']
        },
        bearerTokenEnvVar: 'DOCS_TOKEN'
      },
      {
        id: 'server-3',
        name: 'bad remote',
        enabled: false,
        transport: 'http'
      }
    ])
  })

  it('drops inline plaintext secrets from runtime profile env while preserving references', () => {
    const settings = makeSettings()
    const { sanitizeRuntimeProfileForSave } = makeSanitizers(settings)

    const sanitized = sanitizeRuntimeProfileForSave({
      name: 'Codex secure profile',
      provider: 'codex',
      env: {
        PROJECT_ROOT: '/repo',
        OPENAI_API_KEY: 'sk-1234567890abcdefghijklmnop',
        OPENAI_API_KEY_REF: '${OPENAI_API_KEY}',
        CLIENT_SECRET: '$CLIENT_SECRET'
      },
      secretRefs: {
        env: ['OPENAI_API_KEY', 'bad-name', 'OPENAI_API_KEY']
      }
    })

    expect(sanitized.env).toEqual({
      PROJECT_ROOT: '/repo',
      OPENAI_API_KEY_REF: '${OPENAI_API_KEY}',
      CLIENT_SECRET: '$CLIENT_SECRET'
    })
    expect(sanitized.secretRefs).toEqual({
      env: ['OPENAI_API_KEY']
    })
  })

  it('sanitizes changelog persistence settings', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    const sanitized = sanitizeSettingsPatch({
      lastSeenChangelogVersion: ' 1.0.73 ',
      pendingUpdateChangelog: {
        version: ' 1.0.74 ',
        releaseName: ' TaskWraith 1.0.74 ',
        releaseDate: ' 2026-06-04T13:00:00.000Z ',
        releaseNotes: [
          { version: ' 1.0.74 ', note: 'Updater pill.' },
          { version: '', note: 'ignored' }
        ]
      }
    })

    expect(sanitized).toMatchObject({
      lastSeenChangelogVersion: '1.0.73',
      pendingUpdateChangelog: {
        version: '1.0.74',
        releaseName: 'TaskWraith 1.0.74',
        releaseDate: '2026-06-04T13:00:00.000Z',
        releaseNotes: [{ version: '1.0.74', note: 'Updater pill.' }]
      }
    })
  })

  it('ignores retired Ollama tool-control tier settings', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({
        ollamaToolControlTier: 'provider_parity',
        ollamaProviderParityAcknowledgedAt: '2026-06-08T12:00:00.000Z',
        ollamaProviderParityWorkspaceGrants: {
          '/tmp/project': '2026-06-08T12:01:00.000Z'
        }
      })
    ).toEqual({})
  })

  it('round-trips advancedFx.refraction and coerces non-boolean values', () => {
    const settings = makeSettings() // refraction defaults true in the fixture
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    // Explicit false survives.
    expect(
      sanitizeSettingsPatch({ advancedFx: { ...settings.advancedFx, refraction: false } })
        .advancedFx
    ).toMatchObject({ refraction: false })

    // Explicit true survives.
    expect(
      sanitizeSettingsPatch({ advancedFx: { ...settings.advancedFx, refraction: true } }).advancedFx
    ).toMatchObject({ refraction: true })

    // A malformed/non-boolean value is coerced via Boolean() — never persists as garbage.
    expect(
      sanitizeSettingsPatch({
        advancedFx: { ...settings.advancedFx, refraction: 'yes' as unknown as boolean }
      }).advancedFx
    ).toMatchObject({ refraction: true })
    expect(
      sanitizeSettingsPatch({
        advancedFx: { ...settings.advancedFx, refraction: 0 as unknown as boolean }
      }).advancedFx
    ).toMatchObject({ refraction: false })
  })

  it('back-fills advancedFx.refraction from current when the key is absent', () => {
    const settings = makeSettings({
      advancedFx: {
        agentAura: true,
        livingWorkspace: true,
        dataViz: true,
        refraction: false,
        intensity: 'cinematic'
      }
    })
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    // Patch omits refraction; sanitizer must preserve the current value, not reset to default.
    const sanitized = sanitizeSettingsPatch({
      advancedFx: { agentAura: false } as unknown as AppSettings['advancedFx']
    })
    expect(sanitized.advancedFx).toMatchObject({ agentAura: false, refraction: false })
  })

  it('persists workspace edit-consent acknowledgements and strips malformed rows', () => {
    // Regression: the renderer recorded this workspace-only acknowledgement,
    // but SETTINGS_PATCH_KEYS silently dropped it. It therefore worked only
    // until the next settings reload and every resumed/new chat asked again.
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    const sanitized = sanitizeSettingsPatch({
      approvalModeElevationAcknowledgements: {
        '/work/alpha': true,
        '/work/alpha|codex': true,
        '/work/disabled': false,
        '': true,
        '/work/malformed': 'yes'
      } as unknown as Record<string, boolean>
    })

    expect(sanitized.approvalModeElevationAcknowledgements).toEqual({
      '/work/alpha': true,
      '/work/alpha|codex': true,
      '/work/disabled': false
    })
    expect(
      'approvalModeElevationAcknowledgements' in
        sanitizeSettingsPatch({
          approvalModeElevationAcknowledgements: 'not-a-record' as unknown as Record<
            string,
            boolean
          >
        })
    ).toBe(false)
  })

  it('persists agenticWorkspaceGrants through SettingsService patches (tool-grant enablement)', () => {
    // Regression: agenticWorkspaceGrants was missing from SETTINGS_PATCH_KEYS, so
    // PermissionService.upsertWorkspaceGrant → SettingsService.updateSettings
    // silently dropped every grant write. UI checkboxes never stuck.
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    const grant = {
      id: 'grant-shell-1',
      workspacePath: resolve('/Users/chris/repo'),
      provider: 'codex' as const,
      service: 'shellCommands' as const,
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      expiresOn: 'workspace_revocation' as const
    }
    // Legacy per-provider rows consolidate to the 'agents' wildcard on the way
    // through the sanitizer — the workspace, not the provider, is the unit of
    // consent. Row identity and timestamps survive the rewrite.
    const sanitized = sanitizeSettingsPatch({ agenticWorkspaceGrants: [grant] })
    expect(sanitized.agenticWorkspaceGrants).toEqual([{ ...grant, provider: 'agents' }])
    const publishGrant = {
      ...grant,
      id: 'grant-publish-1',
      service: 'externalPublish' as const
    }
    expect(
      sanitizeSettingsPatch({ agenticWorkspaceGrants: [publishGrant] }).agenticWorkspaceGrants
    ).toEqual([{ ...publishGrant, provider: 'agents' }])

    // The 'agents' wildcard provider is accepted for workspace-scoped mutation grants.
    const agentsGrant = {
      ...grant,
      id: 'grant-agents-1',
      provider: 'agents' as const
    }
    expect(
      sanitizeSettingsPatch({ agenticWorkspaceGrants: [agentsGrant] }).agenticWorkspaceGrants
    ).toEqual([agentsGrant])

    // Empty array is a valid revoke-all write.
    expect(sanitizeSettingsPatch({ agenticWorkspaceGrants: [] }).agenticWorkspaceGrants).toEqual([])

    // Non-grantable services and malformed rows are stripped; garbage input drops the key.
    const mixed = sanitizeSettingsPatch({
      agenticWorkspaceGrants: [
        grant,
        {
          ...grant,
          id: 'grant-eval',
          service: 'canvasEval'
        },
        { not: 'a grant' },
        null
      ]
    })
    expect(mixed.agenticWorkspaceGrants).toEqual([{ ...grant, provider: 'agents' }])
    expect(
      'agenticWorkspaceGrants' in sanitizeSettingsPatch({ agenticWorkspaceGrants: 'nope' })
    ).toBe(false)
  })

  it('consolidates legacy per-provider workspace grants into one agents row per workspace/service', () => {
    const base = {
      workspacePath: resolve('/Users/chris/repo'),
      service: 'fileChanges' as const,
      expiresOn: 'workspace_revocation' as const
    }
    const codex = {
      ...base,
      id: 'grant-codex',
      provider: 'codex' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z'
    }
    const gemini = {
      ...base,
      id: 'grant-gemini',
      provider: 'gemini' as const,
      // Trailing slash on purpose: the resolved path is the dedupe key.
      workspacePath: '/Users/chris/repo/',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z'
    }
    const shell = {
      ...base,
      id: 'grant-shell',
      provider: 'codex' as const,
      service: 'shellCommands' as const,
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z'
    }
    const otherWorkspace = {
      ...codex,
      id: 'grant-elsewhere',
      // Resolved: this row is spread straight into the EXPECTED output, and
      // consolidateAgenticWorkspaceGrants emits resolve(workspacePath).
      workspacePath: resolve('/Users/chris/other')
    }

    const merged = consolidateAgenticWorkspaceGrants([codex, gemini, shell, otherWorkspace])
    expect(merged).toEqual([
      {
        id: 'grant-codex', // first member's id — stable across repeated runs
        workspacePath: resolve('/Users/chris/repo'),
        provider: 'agents',
        service: 'fileChanges',
        createdAt: '2026-04-01T00:00:00.000Z', // earliest consent in the group
        updatedAt: '2026-06-01T00:00:00.000Z', // latest touch in the group
        expiresOn: 'workspace_revocation'
      },
      { ...shell, provider: 'agents' },
      { ...otherWorkspace, provider: 'agents' }
    ])
    // Idempotent: a second pass changes nothing.
    expect(consolidateAgenticWorkspaceGrants(merged)).toEqual(merged)
  })

  it('keeps an existing agents row id, unions expiry, and leaves canvasInteraction rows alone', () => {
    const agentsRow = {
      id: 'grant-agents-keep',
      workspacePath: resolve('/Users/chris/repo'),
      provider: 'agents' as const,
      service: 'fileChanges' as const,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      expiresOn: 'workspace_revocation' as const
    }
    const legacy = {
      ...agentsRow,
      id: 'grant-legacy',
      provider: 'codex' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z'
    }
    const kept = consolidateAgenticWorkspaceGrants([legacy, agentsRow])
    expect(kept).toHaveLength(1)
    expect(kept[0].id).toBe('grant-agents-keep')
    expect(kept[0].createdAt).toBe('2026-05-01T00:00:00.000Z')

    // Expiry survives only when EVERY merged row expires (latest wins); one
    // open-ended consent makes the merged grant open-ended.
    const expiringA = { ...legacy, id: 'e1', expiresAt: '2026-08-01T00:00:00.000Z' }
    const expiringB = {
      ...legacy,
      id: 'e2',
      provider: 'gemini' as const,
      expiresAt: '2026-09-01T00:00:00.000Z'
    }
    const bothExpire = consolidateAgenticWorkspaceGrants([expiringA, expiringB])
    expect(bothExpire[0].expiresAt).toBe('2026-09-01T00:00:00.000Z')
    const oneOpenEnded = consolidateAgenticWorkspaceGrants([expiringA, legacy])
    expect(oneOpenEnded[0].expiresAt).toBeUndefined()

    // canvasInteraction has no workspace tier (surface-scoped), so its rows
    // are never rewritten to a wildcard the gate could not honor.
    const canvasRow = {
      ...legacy,
      id: 'grant-canvas',
      service: 'canvasInteraction' as const
    }
    expect(consolidateAgenticWorkspaceGrants([canvasRow])).toEqual([canvasRow])
  })
})

describe('AntiGravity opt-in admission (S0b settings-aware gate)', () => {
  const optedIn = { antigravityEnabled: true, antigravityOptInAcceptedAt: 1_700_000_000_000 }
  const enabledNoConsent = { antigravityEnabled: true, antigravityOptInAcceptedAt: null }

  it('accepts antigravity as a KNOWN/decode provider id', () => {
    expect(assertProviderId('antigravity')).toBe('antigravity')
    expect(availableProviderIds()).toContain('antigravity')
  })

  it('excludes antigravity from the offer set when settings are absent (fail closed)', () => {
    expect(selectableProviderIds()).not.toContain('antigravity')
    expect(selectableProviderIds(enabledNoConsent)).not.toContain('antigravity')
  })

  it('includes antigravity in the offer set only when enabled AND consent recorded', () => {
    expect(selectableProviderIds(optedIn)).toContain('antigravity')
  })

  it('assertLiveProviderId rejects antigravity without opt-in settings (fail closed)', () => {
    expect(() => assertLiveProviderId('antigravity')).toThrow()
    expect(() => assertLiveProviderId('antigravity', enabledNoConsent)).toThrow()
  })

  it('assertLiveProviderId admits antigravity only with a full opt-in', () => {
    expect(assertLiveProviderId('antigravity', optedIn)).toBe('antigravity')
  })

  it('keeps gemini retired even under a valid antigravity opt-in', () => {
    expect(() => assertLiveProviderId('gemini', optedIn)).toThrow()
  })
})

describe('AntiGravity Gemini API-key admission (independent of the AGY opt-in lane)', () => {
  afterEach(() => {
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
  })

  it('defaults to excluding antigravity when no Gemini API key is configured', () => {
    expect(selectableProviderIds()).not.toContain('antigravity')
    expect(() => assertLiveProviderId('antigravity')).toThrow()
  })

  it('admits antigravity via a configured Gemini API key alone, with no opt-in', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => true)
    expect(selectableProviderIds()).toContain('antigravity')
    expect(assertLiveProviderId('antigravity')).toBe('antigravity')
  })

  it('keeps the AGY opt-in lane admitting antigravity even without a configured key', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => false)
    const optedIn = { antigravityEnabled: true, antigravityOptInAcceptedAt: 1_700_000_000_000 }
    expect(selectableProviderIds(optedIn)).toContain('antigravity')
    expect(assertLiveProviderId('antigravity', optedIn)).toBe('antigravity')
  })

  it('fails closed when neither the opt-in lane nor a configured key admits antigravity', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => false)
    const enabledNoConsent = { antigravityEnabled: true, antigravityOptInAcceptedAt: null }
    expect(selectableProviderIds(enabledNoConsent)).not.toContain('antigravity')
    expect(() => assertLiveProviderId('antigravity', enabledNoConsent)).toThrow()
  })

  it('keeps gemini retired even when a Gemini API key is configured', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => true)
    expect(() => assertLiveProviderId('gemini')).toThrow()
  })
})
