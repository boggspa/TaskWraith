import { describe, expect, it, vi } from 'vitest'
import { TASKWRAITH_FRESH_GATEWAY_MCP_PROFILE_ID } from '../mcp/McpSessionProfileFence'
import {
  ComposerService,
  type ComposerRunPayload,
  type ComposerServiceDeps,
  type ComposerServiceStore
} from './ComposerService'
import type {
  AppSettings,
  ChatRecord,
  EffectiveRunPermissions,
  ExternalPathGrant,
  ProviderId
} from '../store/types'
import {
  clampUntrustedRunPosture,
  runPostureContextFromPayload,
  signRunPermissionPosture,
  verifyRunPermissionPosture
} from '../RunPermissionPosture'
import { TASKWRAITH_RUNTIME_PREAMBLE_VERSION } from '../PromptComposition'
import { KIMI_ACP_PRODUCTION_POSTURE_VERSION } from '../../shared/kimiAcpPosture'
import { DEFAULT_PROVIDER } from '../../shared/retiredProviders'
import {
  resetAntigravityGeminiApiKeyConfiguredProbeForTests,
  setAntigravityGeminiApiKeyConfiguredProbe
} from '../antigravity/AntigravityGeminiApiKeyConfiguredSignal'

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: true,
    storePromptResponseInUsage: true,
    ensembleModeEnabled: true,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 6,
    currency: 'USD',
    kimiSanitiserEnabled: false,
    kimiSanitiserCustomKeywords: '',
    appearanceMode: 'solid',
    visualEffectStyle: 'auto',
    themeAppearance: 'system',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    toolIconAccent: 'system',
    userBubbleColor: 'system',
    appIconVariant: 'regular',
    promptSurfaceStyle: 'theme',
    composerStyle: 'default',
    funFxEnabled: false,
    funFxMode: 'subtle',
    advancedFx: {
      agentAura: false,
      livingWorkspace: false,
      dataViz: false,
      refraction: false,
      intensity: 'subtle'
    },
    reduceTransparency: false,
    reduceMotion: false,
    compactDensity: false,
    liveActivityViewport: true,
    showInspector: true,
    inspectorWidth: 360,
    sidebarWidth: 260,
    sidebarOpacity: 100,
    mainPaneOpacity: 100,
    agenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      sketchCanvas: 'allow',
      meshCanvas: 'ask',
      canvasEval: 'ask',
      networkAccess: 'allow'
    },
    agenticWorkspaceGrants: [],
    autoResumeParentOnSubThreadCompletion: true,
    geminiMcpBridgeEnabled: false,
    codexSandboxFallback: 'ask_rerun',
    updateChannel: 'stable',
    approvalTimeouts: {
      enabled: true,
      perProviderMs: {
        gemini: 30_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000,
        grok: 120_000,
        cursor: 120_000,
        ollama: 120_000,
        antigravity: 120_000,
        pi: 120_000,
        mistral: 120_000,
      },
      mainAuthorityMs: 30_000
    },
    ...overrides
  }
}

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: DEFAULT_PROVIDER,
    title: 'Chat',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'Previous question',
        timestamp: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Previous answer',
        timestamp: '2026-01-01T00:00:01.000Z'
      }
    ],
    runs: [],
    ...overrides
  }
}

function makeDeps(
  chat: ChatRecord,
  settings: Partial<AppSettings> = {}
): {
  deps: ComposerServiceDeps
  store: ComposerServiceStore
} {
  const store: ComposerServiceStore = {
    getChat: vi.fn(() => chat)
  }
  return {
    store,
    deps: {
      appStore: store,
      getSettings: vi.fn(() => makeSettings(settings))
    }
  }
}

function compose(
  chatOverrides: Partial<ChatRecord>,
  inputOverrides: Record<string, unknown>,
  settings: Partial<AppSettings> = {}
): ComposerRunPayload {
  const chat = makeChat(chatOverrides)
  const { deps } = makeDeps(chat, settings)
  const service = new ComposerService(deps)
  return service.composeRun({
    chatId: chat.appChatId,
    provider: chat.provider as ProviderId,
    workspace: chat.workspacePath,
    userInput: 'Do the thing',
    selectedModelType: 'cli-default',
    approvalMode: 'default',
    ...inputOverrides
  })
}

function makeGrant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'grant-1',
    provider: 'codex',
    path: '/outside/file.txt',
    kind: 'file',
    access: 'read',
    duration: 'thisThread',
    issuedBy: 'main',
    signature: 'signed',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('ComposerService', () => {
  it('isolates execution-graph attempts from transcript and native-session context', () => {
    const payload = compose(
      {
        provider: 'codex',
        linkedProviderSessionId: 'thread-old'
      },
      {
        provider: 'codex',
        selectedModelType: 'gpt-5.6',
        contextIsolation: 'execution_graph'
      }
    )

    expect(payload.providerSessionId).toBeNull()
    expect(payload.composer.providerSessionId).toBeNull()
    expect(payload.composer.contextTurnsApplied).toBe(0)
    expect(payload.prompt).not.toContain('Previous question')
    expect(payload.prompt).not.toContain('Previous answer')
    expect(payload.prompt).toContain('Do the thing')
  })

  it('isolates execution-graph Ollama attempts from root-chat memory and metadata', () => {
    const payload = compose(
      {
        provider: 'ollama',
        ollamaSessionMemory: {
          modelId: 'llama3.2',
          updatedAt: 1_767_225_600_000,
          workingMemory: 'Secret prior-thread instruction.',
          toolTurnCount: 4
        },
        providerMetadata: {
          ollamaRunProfile: 'deep',
          taskWraithRuntimePreambleVersion: 'stale-version'
        }
      },
      {
        provider: 'ollama',
        selectedModelType: 'llama3.2',
        contextIsolation: 'execution_graph'
      }
    )

    expect(payload.prompt).not.toContain('Secret prior-thread instruction.')
    expect(payload.ollamaRunProfile).toBeUndefined()
    expect(payload.composer.providerMetadataPatch).toBeUndefined()
  })

  it('defaults fresh Claude sessions to gateway even when the deprecated core flag is set', () => {
    const previous = process.env.TASKWRAITH_CORE_MCP_PROFILE
    process.env.TASKWRAITH_CORE_MCP_PROFILE = '1'
    try {
      const payload = compose({ provider: 'claude' }, {}, { geminiMcpBridgeEnabled: true })
      expect(payload.taskWraithMcpProfileId).toBe(TASKWRAITH_FRESH_GATEWAY_MCP_PROFILE_ID)
      expect(payload.prompt).toContain('TaskWraith gateway MCP profile is active')
      expect(payload.prompt).not.toContain('Image tools are also available over MCP')
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CORE_MCP_PROFILE
      else process.env.TASKWRAITH_CORE_MCP_PROFILE = previous
    }
  })

  it('does not claim MCP/gateway is active when the Claude bridge setting is disabled', () => {
    const previous = process.env.TASKWRAITH_CORE_MCP_PROFILE
    process.env.TASKWRAITH_CORE_MCP_PROFILE = '1'
    try {
      const payload = compose(
        { provider: 'claude' },
        { userInput: 'blur the screenshot' },
        { geminiMcpBridgeEnabled: false }
      )
      expect(payload.taskWraithMcpAdvertised).toBe(false)
      expect(payload.prompt).not.toContain('TaskWraith core MCP profile is active')
      expect(payload.prompt).not.toContain('TaskWraith gateway MCP profile is active')
      expect(payload.prompt).not.toContain('Image tools are also available over MCP')
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CORE_MCP_PROFILE
      else process.env.TASKWRAITH_CORE_MCP_PROFILE = previous
    }
  })

  it('keeps Pi generic MCP unadvertised until its launch-time coordination receipt', () => {
    const payload = compose(
      { provider: 'pi' },
      { userInput: 'Ask the next participant to review the findings.' },
      { geminiMcpBridgeEnabled: true }
    )

    expect(payload.taskWraithMcpAdvertised).toBe(false)
    expect(payload.prompt).not.toContain('TaskWraith core MCP profile is active')
    expect(payload.prompt).not.toContain('TaskWraith gateway MCP profile is active')
    expect(payload.prompt).not.toContain('capability_search')
  })

  it('honors a pinned Claude core receipt after the rollout flag is disabled', () => {
    const previous = process.env.TASKWRAITH_CORE_MCP_PROFILE
    delete process.env.TASKWRAITH_CORE_MCP_PROFILE
    try {
      const payload = compose(
        {
          provider: 'claude',
          linkedProviderSessionId: 'claude-session-1',
          taskWraithMcpProfileReceipt: {
            schemaVersion: 1,
            profileId: 'taskwraith-core-v1',
            provider: 'claude',
            providerSessionId: 'claude-session-1',
            pinnedAt: '2026-07-11T10:00:00.000Z'
          }
        },
        {}
      )
      expect(payload.providerSessionId).toBe('claude-session-1')
      expect(payload.taskWraithMcpAdvertised).toBe(true)
      expect(payload.taskWraithMcpProfileId).toBe('taskwraith-core-v1')
      expect(payload.prompt).not.toContain('TaskWraith image tools are available over MCP')
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CORE_MCP_PROFILE
      else process.env.TASKWRAITH_CORE_MCP_PROFILE = previous
    }
  })

  it('keeps pinned full-profile Claude capability prose truthful when the toggle is off', () => {
    const payload = compose(
      {
        provider: 'claude',
        linkedProviderSessionId: 'claude-session-1',
        taskWraithMcpProfileReceipt: {
          schemaVersion: 1,
          profileId: 'taskwraith-full-v1',
          provider: 'claude',
          providerSessionId: 'claude-session-1',
          pinnedAt: '2026-07-11T10:00:00.000Z'
        }
      },
      { userInput: 'blur the screenshot' },
      { geminiMcpBridgeEnabled: false }
    )

    expect(payload.providerSessionId).toBe('claude-session-1')
    expect(payload.taskWraithMcpAdvertised).toBe(true)
    expect(payload.taskWraithMcpProfileId).toBe('taskwraith-full-v1')
    expect(payload.prompt).toContain('Image tools are also available over MCP')
  })

  it('normalizes a default Grok model before composing image-tool capability prose', () => {
    const previous = process.env.TASKWRAITH_GROK_ACP
    process.env.TASKWRAITH_GROK_ACP = '1'
    try {
      const payload = compose(
        { provider: 'grok' },
        { selectedModelType: 'cli-default', userInput: 'blur the screenshot' }
      )
      expect(payload.taskWraithMcpProfileId).toBe(TASKWRAITH_FRESH_GATEWAY_MCP_PROFILE_ID)
      expect(payload.prompt).toContain('TaskWraith gateway MCP profile is active')
      expect(payload.prompt).not.toContain('Image tools are also available over MCP')
      expect(payload.prompt).not.toContain('TaskWraith image tools are available over MCP')
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_GROK_ACP
      else process.env.TASKWRAITH_GROK_ACP = previous
    }
  })

  it('does not claim an ACP profile when the retired override fails the run closed', () => {
    const previous = process.env.TASKWRAITH_GROK_ACP
    process.env.TASKWRAITH_GROK_ACP = '0'
    try {
      const payload = compose(
        { provider: 'grok' },
        { selectedModelType: 'cli-default', userInput: 'blur the screenshot' }
      )
      expect(payload.taskWraithMcpProfileId).toBe('taskwraith-full-v1')
      expect(payload.prompt).not.toContain('TaskWraith gateway MCP profile is active')
      expect(payload.prompt).not.toContain('Image tools are also available over MCP')
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_GROK_ACP
      else process.env.TASKWRAITH_GROK_ACP = previous
    }
  })

  it('does not claim core for ACP read-only Grok when advertise gates are off', () => {
    const previousAcp = process.env.TASKWRAITH_GROK_ACP
    const previousReadOnly = process.env.TASKWRAITH_GROK_READONLY_MCP
    process.env.TASKWRAITH_GROK_ACP = '1'
    delete process.env.TASKWRAITH_GROK_READONLY_MCP
    try {
      const payload = compose(
        { provider: 'grok' },
        { selectedModelType: 'cli-default', approvalMode: 'plan', workflowMode: 'normal' }
      )
      expect(payload.taskWraithMcpProfileId).toBe('taskwraith-full-v1')
      expect(payload.prompt).not.toContain('TaskWraith core MCP profile is active')
    } finally {
      if (previousAcp === undefined) delete process.env.TASKWRAITH_GROK_ACP
      else process.env.TASKWRAITH_GROK_ACP = previousAcp
      if (previousReadOnly === undefined) delete process.env.TASKWRAITH_GROK_READONLY_MCP
      else process.env.TASKWRAITH_GROK_READONLY_MCP = previousReadOnly
    }
  })

  it('rejects a new Gemini run from a linked historical Gemini chat', () => {
    const chat = makeChat({
      provider: 'gemini',
      linkedGeminiSessionId: 'gemini-session-1'
    })
    const { deps } = makeDeps(chat)
    const service = new ComposerService(deps)
    expect(() =>
      service.composeRun({
        chatId: chat.appChatId,
        provider: 'gemini',
        workspace: chat.workspacePath,
        userInput: 'Continue the historical chat.',
        selectedModelType: 'flash-lite',
        approvalMode: 'plan'
      })
    ).toThrow('gemini is unavailable for new runs.')
  })

  it('carries the per-chat Ollama run profile from providerMetadata onto the run payload', () => {
    const payload = compose(
      {
        provider: 'ollama',
        providerMetadata: {
          ollamaRunProfile: 'verify_with_shell'
        }
      },
      { selectedModelType: 'gpt-oss:latest' },
      {}
    )
    expect(payload.ollamaRunProfile).toBe('verify_with_shell')
  })

  it('omits the per-chat Ollama run profile when the chat has none', () => {
    const payload = compose(
      { provider: 'ollama', providerMetadata: {} },
      { selectedModelType: 'gpt-oss:latest' },
      {}
    )
    expect(payload.ollamaRunProfile).toBeUndefined()
  })

  it('does not revive Gemini when a historical chat supplies the provider fallback', () => {
    const chat = makeChat({ provider: 'gemini' })
    const { deps } = makeDeps(chat)
    const service = new ComposerService(deps)
    expect(() =>
      service.composeRun({
        chatId: chat.appChatId,
        workspace: chat.workspacePath,
        userInput: 'Start another run.',
        selectedModelType: 'flash-lite',
        approvalMode: 'default'
      })
    ).toThrow('gemini is unavailable for new runs.')
  })

  it('rejects a new antigravity run when no Gemini API key is configured', () => {
    expect(() => compose({ provider: 'antigravity' }, {})).toThrow(
      'antigravity is unavailable for new runs.'
    )
  })

  it('admits a new antigravity run once a Gemini API key is configured, with no AGY opt-in', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => true)
    try {
      const payload = compose({ provider: 'antigravity' }, {})
      expect(payload.provider).toBe('antigravity')
    } finally {
      resetAntigravityGeminiApiKeyConfiguredProbeForTests()
    }
  })

  it('still rejects the official agy/CLI antigravity lane from interactive compose even with a configured key', () => {
    // Interactive compose only ever dispatches the in-app Gemini API kernel;
    // the agy/CLI lane always opens an external terminal instead, so a
    // configured key alone does not change that this local admission check
    // never depends on the AGY opt-in flag.
    setAntigravityGeminiApiKeyConfiguredProbe(() => false)
    try {
      expect(() => compose({ provider: 'antigravity' }, {})).toThrow(
        'antigravity is unavailable for new runs.'
      )
    } finally {
      resetAntigravityGeminiApiKeyConfiguredProbeForTests()
    }
  })

  it('maps non-plan global runs back to default approval mode', () => {
    const payload = compose(
      { provider: 'codex', scope: 'global', workspacePath: undefined },
      {
        provider: 'codex',
        selectedModelType: 'cli-default',
        scope: 'global',
        workspace: undefined,
        approvalMode: 'auto_edit'
      }
    )
    expect(payload.scope).toBe('global')
    expect(payload.workspace).toBeUndefined()
    expect(payload.approvalMode).toBe('default')
  })

  it('builds Kimi prompts with conversation context even when resuming a provider session', () => {
    const payload = compose(
      { provider: 'kimi', linkedProviderSessionId: 'kimi-thread-1' },
      { selectedModelType: 'kimi-k2.6', kimiThinkingEnabled: false }
    )
    expect(payload.provider).toBe('kimi')
    expect(payload.providerSessionId).toBe('kimi-thread-1')
    expect(payload.prompt).toContain('Conversation context')
    expect(payload.kimiThinking).toBe(true)
    expect(payload.composer.applicationLog).toContain(
      'Kimi: appending compact conversation context'
    )
  })

  it('pairs a slim native Kimi ACP resume prompt with a full-context fallback', () => {
    const payload = compose(
      {
        provider: 'kimi',
        linkedProviderSessionId: 'session_native_1',
        providerMetadata: {
          kimiAcpNativeSession: true,
          kimiAcpPostureVersion: KIMI_ACP_PRODUCTION_POSTURE_VERSION,
          taskWraithRuntimePreambleVersion: TASKWRAITH_RUNTIME_PREAMBLE_VERSION,
          taskWraithRuntimePreambleProvider: 'kimi'
        }
      },
      { selectedModelType: 'kimi-k2.7-code' }
    )

    expect(payload.prompt).not.toContain('Conversation context')
    expect(payload.resumeFallbackPrompt).toContain('Conversation context')
    expect(payload.composer.applicationLog).toContain('resuming Kimi Code ACP session context')
  })

  it('does not slim-resume a legacy boolean-only Kimi ACP record', () => {
    const payload = compose(
      {
        provider: 'kimi',
        linkedProviderSessionId: 'session_legacy',
        providerMetadata: { kimiAcpNativeSession: true }
      },
      { selectedModelType: 'kimi-k2.7-code' }
    )

    expect(payload.prompt).toContain('Conversation context')
    expect(payload.resumeFallbackPrompt).toBeUndefined()
  })

  it('defaults Kimi thinking to true from provider metadata defaults', () => {
    const payload = compose({ provider: 'kimi' }, { selectedModelType: undefined })
    expect(payload.model).toBe('kimi-k2.7-code')
    expect(payload.kimiThinking).toBe(true)
    expect(payload.serviceTier).toBe('standard')
  })

  it('threads K3 effort while keeping thinking always on', () => {
    const payload = compose(
      { provider: 'kimi' },
      {
        selectedModelType: 'kimi-k3',
        kimiReasoningEffort: 'high',
        kimiFastMode: true,
        kimiThinkingEnabled: false
      }
    )
    expect(payload.model).toBe('kimi-k3')
    expect(payload.reasoningEffort).toBe('high')
    expect(payload.serviceTier).toBe('standard')
    expect(payload.kimiThinking).toBe(true)
  })

  it('defaults K3 effort to Max and ignores unsupported Off', () => {
    const payload = compose(
      { provider: 'kimi' },
      { selectedModelType: 'kimi-k3', kimiReasoningEffort: 'off' }
    )
    expect(payload.reasoningEffort).toBe('max')
    expect(payload.kimiThinking).toBe(true)
  })

  it('maps the Kimi Fast selection to the HighSpeed service tier', () => {
    const selected = compose(
      { provider: 'kimi' },
      { selectedModelType: 'kimi-k2.7-code', kimiFastMode: true }
    )
    const persisted = compose(
      { provider: 'kimi', providerMetadata: { kimiFastMode: true } },
      { selectedModelType: 'kimi-k2.7-code' }
    )

    expect(selected.serviceTier).toBe('fast')
    expect(persisted.serviceTier).toBe('fast')
    expect(selected.kimiThinking).toBe(true)
  })

  it('teaches Kimi about cross-provider delegate_to_subthread (Phase I4)', () => {
    // The runtime note must point Kimi at TaskWraith__delegate_to_subthread
    // so it doesn't reach for a built-in generalist agent when asked to
    // delegate to Gemini / Codex / Claude.
    const payload = compose(
      { provider: 'kimi' },
      { userInput: 'Use a subagent to review this and delegate a pass.' }
    )
    expect(payload.prompt).toContain('TaskWraith MCP server')
    expect(payload.prompt).toContain('TaskWraith__delegate_to_subthread')
    expect(payload.prompt).toContain('CROSS-PROVIDER delegation')
    expect(payload.prompt).toContain("provider: 'claude'")
    expect(payload.prompt).toContain('do not use provider-native multi-agent orchestration paths')
    expect(payload.prompt).toContain('RECALL')
    expect(payload.prompt).toContain('subThreadId')
    expect(payload.prompt).not.toContain('Complete TaskWraith tool list')
  })

  it('omits the Kimi delegation preamble in plan mode (read-only sessions)', () => {
    const payload = compose({ provider: 'kimi' }, { approvalMode: 'plan' })
    expect(payload.prompt).not.toContain('TaskWraith MCP server')
    expect(payload.prompt).not.toContain('TaskWraith__delegate_to_subthread')
    expect(payload.prompt).toContain('Do the thing')
  })

  it('omits the Kimi delegation preamble for global-scope runs (no workspace)', () => {
    const payload = compose(
      { provider: 'kimi', scope: 'global', workspacePath: undefined, workspaceId: undefined },
      {}
    )
    expect(payload.prompt).not.toContain('TaskWraith MCP server')
    expect(payload.prompt).not.toContain('TaskWraith__delegate_to_subthread')
    expect(payload.prompt).toContain('Do the thing')
  })

  it('strips internal plan markdown blocks and forces plan approval mode', () => {
    const payload = compose(
      { provider: 'kimi' },
      {
        selectedModelType: 'kimi-k2.6',
        userInput: 'Yes, proceed.\n\n```plan\n1. inspect\n2. edit\n```'
      }
    )
    expect(payload.approvalMode).toBe('plan')
    expect(payload.workflowMode).toBe('plan')
    expect(payload.composer.workflowMode).toBe('plan')
    expect(payload.composer.planModeParsed).toBe(true)
    expect(payload.prompt).toContain('Yes, proceed.')
    expect(payload.prompt).not.toContain('```plan')
  })

  it('keeps legacy plan approval mode in normal workflow when no workflow is explicit', () => {
    const payload = compose({ provider: 'codex' }, { approvalMode: 'plan' })
    expect(payload.approvalMode).toBe('plan')
    expect(payload.workflowMode).toBe('normal')
    expect(payload.composer.workflowMode).toBe('normal')
  })

  it('keeps explicit normal workflow separate from read-only plan permissions', () => {
    const payload = compose({ provider: 'codex' }, { approvalMode: 'plan', workflowMode: 'normal' })
    expect(payload.approvalMode).toBe('plan')
    expect(payload.workflowMode).toBe('normal')
    expect(payload.composer.workflowMode).toBe('normal')
    expect(payload.effectivePermissions?.readOnly).toBe(true)
    // Posture split: the Read-Only/Recon row resolves the strict floor preset —
    // no elevation path (subthread/canvas denied).
    expect(payload.effectivePermissions?.presetId).toBe('read_only')
    expect(payload.effectivePermissions?.agenticServices.subThreadDelegation).toBe('deny')
    expect(payload.effectivePermissions?.agenticServices.canvasInteraction).toBe('deny')
  })

  it('uses persisted plan workflow to force plan approval mode', () => {
    const payload = compose(
      { provider: 'claude', workflowMode: 'plan' },
      { approvalMode: 'default' }
    )
    expect(payload.approvalMode).toBe('plan')
    expect(payload.workflowMode).toBe('plan')
    expect(payload.composer.workflowMode).toBe('plan')
  })

  it('posture split: a Plan-workflow solo run resolves the plan instrument tier', () => {
    const payload = compose(
      { provider: 'claude', workflowMode: 'plan' },
      { approvalMode: 'default' }
    )
    expect(payload.approvalMode).toBe('plan')
    expect(payload.workflowMode).toBe('plan')
    expect(payload.effectivePermissions?.readOnly).toBe(true)
    // The Plan row is now genuinely distinct from Read-Only/Recon: canvas/media/
    // subthread are approval-queued (the W7 instrument tier)…
    expect(payload.effectivePermissions?.presetId).toBe('plan')
    expect(payload.effectivePermissions?.agenticServices.canvasInteraction).toBe('ask')
    expect(payload.effectivePermissions?.agenticServices.mediaEditing).toBe('ask')
    expect(payload.effectivePermissions?.agenticServices.subThreadDelegation).toBe('ask')
    // …while direct writes remain denied (plan is not a write mode).
    expect(payload.effectivePermissions?.agenticServices.fileChanges).toBe('deny')
    expect(payload.effectivePermissions?.agenticServices.shellCommands).toBe('deny')
  })

  it('1.0.4-AF: strips a leading /discuss token and flags selfReflectiveRequested', () => {
    // /discuss is the prefix-shaped sibling of the ```plan``` fenced
    // block: a composer-level slash signal that the user wants the
    // ensemble's deictic rule to flip toward TaskWraith itself for the
    // round. The token never reaches the provider — it's a marker
    // for the orchestrator (or future self-reflective UI) to read.
    const payload = compose(
      { provider: 'claude' },
      {
        selectedModelType: 'claude-opus-4-8-1m',
        userInput: '/discuss what would the panel say about ensemble pacing?'
      }
    )
    expect(payload.composer.selfReflectiveRequested).toBe(true)
    expect(payload.prompt).toContain('what would the panel say about ensemble pacing?')
    expect(payload.prompt).not.toContain('/discuss')
    // /discuss is independent of plan mode — approval mode should stay
    // at whatever the caller asked for (default here).
    expect(payload.approvalMode).toBe('default')
    expect(payload.composer.planModeParsed).toBeFalsy()
  })

  it('1.0.4-AF: accepts /meta as an alias for /discuss with the same flag', () => {
    const payload = compose(
      { provider: 'claude' },
      { selectedModelType: 'cli-default', userInput: '/meta let us reflect on the harness UX' }
    )
    expect(payload.composer.selfReflectiveRequested).toBe(true)
    expect(payload.prompt).toContain('let us reflect on the harness UX')
    expect(payload.prompt).not.toMatch(/^\/meta/)
  })

  it('1.0.4-AF: /discuss composes with a plan markdown block — both signals fire', () => {
    // Plan Mode and Ensemble self-reflective mode are orthogonal:
    // Plan controls per-participant permission posture; self-
    // reflective controls deictic resolution. A prompt that opens
    // with /discuss AND carries a ```plan``` block should set both.
    const payload = compose(
      { provider: 'kimi' },
      {
        selectedModelType: 'kimi-k2.6',
        userInput: '/discuss outline the cleanup\n\n```plan\n1. inventory\n```'
      }
    )
    expect(payload.composer.selfReflectiveRequested).toBe(true)
    expect(payload.composer.planModeParsed).toBe(true)
    expect(payload.approvalMode).toBe('plan')
    expect(payload.prompt).toContain('outline the cleanup')
    expect(payload.prompt).not.toContain('/discuss')
    expect(payload.prompt).not.toContain('```plan')
  })

  it('1.0.4-AF: does NOT fire on /discuss buried inside the prompt body', () => {
    // Only a leading /discuss token triggers the flag. Users
    // discussing the command itself ("explain /discuss") should not
    // accidentally flip the ensemble's mode.
    const payload = compose(
      { provider: 'claude' },
      {
        selectedModelType: 'cli-default',
        userInput: 'Please explain how /discuss differs from /plan.'
      }
    )
    expect(payload.composer.selfReflectiveRequested).toBeFalsy()
    expect(payload.prompt).toContain('/discuss')
  })

  it('teaches Codex about cross-provider delegate_to_subthread (Phase I2 prompt-level fix)', () => {
    // Empirical bug: Codex CLI registered the TaskWraith MCP server
    // correctly (~/Library/Logs/TaskWraith/bridge-subprocess.log shows
    // 100+ codex-parented bridge spawns) but the Codex agent itself
    // never invoked a single tool — zero tools/call entries from any
    // codex-parented bridge. Claude/Kimi each got a delegation
    // runtime-note preamble in Phase I3/I4 and immediately started
    // calling delegate_to_subthread; Codex was the only provider
    // missing the preamble.
    const payload = compose(
      { provider: 'codex' },
      { userInput: 'Use a parallel review agent and delegate the audit.' }
    )
    expect(payload.prompt).toContain('TaskWraith MCP server')
    expect(payload.prompt).toContain('TaskWraith__delegate_to_subthread')
    expect(payload.prompt).toContain('CROSS-PROVIDER delegation')
    expect(payload.prompt).toContain("provider: 'claude'")
    expect(payload.prompt).toContain('do not use provider-native multi-agent orchestration paths')
    // Recall guidance — observed bug: Codex spawning a fresh sub-thread
    // on every status check, getting "first turn, no prior actions"
    // back from sub-agents with legitimately no history.
    expect(payload.prompt).toContain('RECALL')
    expect(payload.prompt).toContain('subThreadId')
    expect(payload.prompt).not.toContain('Complete TaskWraith tool list')
  })

  it('omits the Codex delegation preamble in plan mode (read-only sessions)', () => {
    const payload = compose({ provider: 'codex' }, { approvalMode: 'plan' })
    expect(payload.prompt).not.toContain('TaskWraith MCP server')
    expect(payload.prompt).not.toContain('TaskWraith__delegate_to_subthread')
    expect(payload.prompt).toContain('Do the thing')
  })

  it('omits the Codex delegation preamble for global-scope runs (no workspace)', () => {
    const payload = compose(
      { provider: 'codex', scope: 'global', workspacePath: undefined, workspaceId: undefined },
      {}
    )
    expect(payload.prompt).not.toContain('TaskWraith MCP server')
    expect(payload.prompt).not.toContain('TaskWraith__delegate_to_subthread')
    expect(payload.prompt).toContain('Do the thing')
  })

  it('builds Codex payloads with image paths and external grant prompt references without packing app-server input', () => {
    const payload = compose(
      { provider: 'codex' },
      {
        selectedModelType: 'gpt-5.5',
        attachments: [{ id: 'img-1', path: '/tmp/screen.png', name: 'screen.png' }],
        externalPathGrants: [makeGrant({ access: 'write', kind: 'directory', path: '/outside' })],
        codexReasoningEffort: 'xhigh',
        codexServiceTier: 'fast'
      }
    )
    expect(payload.prompt).toContain('Attachment references for this request')
    expect(payload.prompt).toContain('User-approved additional workspace access for this request')
    expect(payload.imagePaths).toEqual(['/tmp/screen.png'])
    expect(payload.reasoningEffort).toBe('xhigh')
    expect(payload.serviceTier).toBe('fast')
  })

  it('allows attachments to be the prompt content when text is blank', () => {
    const payload = compose(
      { provider: 'codex' },
      {
        selectedModelType: 'gpt-5.5',
        userInput: '   ',
        attachments: [{ id: 'img-1', path: '/tmp/screen.png', name: 'screen.png' }]
      }
    )

    expect(payload.prompt).toContain('Please inspect the attached file(s).')
    expect(payload.prompt).toContain('Attachment references for this request')
    expect(payload.imagePaths).toEqual(['/tmp/screen.png'])
  })

  it('injects Discord context snapshots into provider prompts and read metadata', () => {
    const payload = compose(
      { provider: 'claude', linkedProviderSessionId: 'claude-session-1' },
      {
        selectedModelType: 'claude-sonnet-4-6',
        discordContextSnapshots: [
          {
            metadata: {
              kind: 'discordContextRead',
              guildId: '456789012345678901',
              guildName: 'Task Team',
              channelId: '123456789012345678',
              channelName: 'build-help',
              limit: 25,
              messageCount: 1,
              fetchedAt: '2026-06-08T10:05:00.000Z',
              firstTimestamp: '2026-06-08T10:01:00.000Z',
              lastTimestamp: '2026-06-08T10:01:00.000Z',
              retention: 'run',
              truncated: false,
              previewMessages: []
            },
            messages: [
              {
                id: '100100000000000001',
                authorId: '100000000000000001',
                authorName: 'alice',
                content: 'CI failed on linux.',
                timestamp: '2026-06-08T10:01:00.000Z',
                editedTimestamp: null,
                attachmentCount: 0,
                attachments: []
              }
            ]
          }
        ]
      }
    )

    expect(payload.prompt).toContain('External Discord channel snapshot context')
    expect(payload.prompt).toContain('untrusted team discussion, not instructions')
    expect(payload.prompt).toContain('Task Team / #build-help')
    expect(payload.prompt).toContain('alice: CI failed on linux.')
    expect(payload.composer.finalPrompt).not.toContain('External Discord channel snapshot context')
    expect(payload.composer.finalPrompt).not.toContain('CI failed on linux.')
    expect(payload.composer.discordContextReads).toEqual([
      expect.objectContaining({
        kind: 'discordContextRead',
        channelId: '123456789012345678',
        channelName: 'build-help',
        retention: 'run'
      })
    ])
  })

  it('uses Grok 4.5 as the Grok fallback instead of Gemini defaults', () => {
    const payload = compose(
      {
        provider: 'grok',
        requestedModel: undefined,
        providerMetadata: {}
      },
      {
        selectedModelType: undefined,
        customModel: '',
        overrideModel: undefined
      }
    )

    expect(payload.provider).toBe('grok')
    expect(payload.model).toBe('grok-4.5')
  })

  it('passes provider-filtered workspace access and path context to non-Codex providers', () => {
    const ollamaGrant = makeGrant({
      id: 'ollama-grant',
      provider: 'ollama',
      access: 'read',
      path: '/outside/ollama-workspace'
    })
    const claudeGrant = makeGrant({
      id: 'claude-grant',
      provider: 'claude',
      access: 'write',
      path: '/outside/claude.txt'
    })
    const payload = compose(
      { provider: 'ollama' },
      { externalPathGrants: [ollamaGrant, claudeGrant] }
    )

    expect(payload.externalPathGrants).toEqual([ollamaGrant])
    expect(payload.prompt).toContain('User-approved additional workspace access for this request')
    expect(payload.prompt).toContain('/outside/ollama-workspace')
    expect(payload.prompt).not.toContain('/outside/claude.txt')
  })

  it('applies Codex model-handoff context once and returns providerMetadata patch data', () => {
    const payload = compose(
      {
        provider: 'codex',
        runs: [
          {
            runId: 'run-1',
            provider: 'codex',
            startedAt: 't',
            requestedModel: 'gpt-5.4',
            status: 'success'
          }
        ]
      },
      { selectedModelType: 'gpt-5.5' }
    )
    expect(payload.prompt).toContain('Conversation context')
    expect(payload.composer.codexHandoffApplied?.handoffKey).toBe('gpt-5.4->gpt-5.5')
    expect(payload.composer.providerMetadataPatch).toMatchObject({
      codexModelContextAppliedKeys: ['gpt-5.4->gpt-5.5']
    })
  })

  it('injects active goals using the provider that will handle the next run', () => {
    const payload = compose(
      {
        provider: 'ollama',
        activeGoal: {
          id: 'goal-1',
          objective: 'Keep the portable goal mode honest',
          status: 'active',
          mode: 'codex_native',
          provider: 'codex',
          createdAt: '2026-06-13T12:00:00Z',
          updatedAt: '2026-06-13T12:00:00Z'
        }
      },
      {}
    )

    expect(payload.prompt).toContain('Provider mode: Ollama managed')
    expect(payload.prompt).not.toContain('Provider mode: Native Codex goal')
  })

  it('carries Grok native goals as structured run state without prompt steering', () => {
    const payload = compose(
      {
        provider: 'grok',
        activeGoal: {
          id: 'goal-1',
          objective: 'Use the official Grok goal mode',
          status: 'active',
          mode: 'taskwraith_steered',
          provider: 'gemini',
          createdAt: '2026-06-22T12:00:00Z',
          updatedAt: '2026-06-22T12:00:00Z'
        }
      },
      {}
    )

    expect(payload.activeGoal).toMatchObject({
      id: 'goal-1',
      objective: 'Use the official Grok goal mode',
      provider: 'grok',
      mode: 'grok_native'
    })
    expect(payload.prompt).not.toContain('<taskwraith_active_goal>')
    expect(payload.prompt).not.toContain('Use the official Grok goal mode')
  })

  it('does not repeat Codex model-handoff context after the handoff key was applied', () => {
    const payload = compose(
      {
        provider: 'codex',
        providerMetadata: { codexModelContextAppliedKeys: ['gpt-5.4->gpt-5.5'] },
        runs: [
          {
            runId: 'run-1',
            provider: 'codex',
            startedAt: 't',
            requestedModel: 'gpt-5.4',
            status: 'success'
          }
        ]
      },
      { selectedModelType: 'gpt-5.5' }
    )
    expect(payload.prompt).not.toContain('Conversation context')
    expect(payload.composer.providerMetadataPatch).not.toHaveProperty(
      'codexModelContextAppliedKeys'
    )
  })

  it('builds Claude payloads without generic context and includes Claude reasoning/fast settings', () => {
    const payload = compose(
      {
        provider: 'claude',
        linkedProviderSessionId: 'claude-thread-1',
        providerMetadata: {
          taskWraithRuntimePreambleVersion: TASKWRAITH_RUNTIME_PREAMBLE_VERSION,
          taskWraithRuntimePreambleProvider: 'claude'
        }
      },
      {
        selectedModelType: 'claude-sonnet-4-6',
        claudeReasoningEffort: 'medium',
        claudeFastMode: true
      }
    )
    // Phase I3 (Claude initiator): workspace Claude runs outside plan
    // mode get a delegation preamble pointing at the TaskWraith MCP
    // server. The user request is preserved verbatim after it.
    //
    // Tier 1 (turn-1 only): when a Claude session is being resumed via
    // `linkedProviderSessionId`, the prior turn's preamble is already in
    // the retained context. We skip re-injection to save ~1.9k tokens
    // per turn. The user prompt is still preserved; the preamble text
    // must NOT be present on resume turns.
    expect(payload.prompt).toContain('Do the thing')
    expect(payload.prompt).not.toContain('mcp__TaskWraith__delegate_to_subthread')
    expect(payload.prompt).not.toContain('TaskWraith MCP server')
    expect(payload.providerSessionId).toBe('claude-thread-1')
    expect(payload.claudeReasoningEffort).toBe('medium')
    expect(payload.claudeFastMode).toBe(true)
  })

  it('falls back to chat metadata for Claude fast mode', () => {
    const payload = compose(
      { provider: 'claude', providerMetadata: { claudeFastMode: true } },
      { selectedModelType: 'claude-opus-4-7' }
    )

    expect(payload.claudeFastMode).toBe(true)
  })

  it('teaches Claude about cross-provider delegate_to_subthread (Phase I3)', () => {
    // The runtime note must point Claude at mcp__TaskWraith__delegate_to_subthread
    // so it doesn't reach for its built-in Task tool when asked to
    // delegate to Codex.
    const payload = compose(
      { provider: 'claude' },
      { userInput: 'Use a review agent and delegate one pass to Codex.' },
      { geminiMcpBridgeEnabled: true }
    )
    expect(payload.prompt).toContain('TaskWraith MCP server')
    expect(payload.prompt).toContain('mcp__TaskWraith__delegate_to_subthread')
    expect(payload.prompt).toContain('CROSS-PROVIDER delegation')
    expect(payload.prompt).toContain("provider: 'codex'")
    expect(payload.prompt).toContain('do not use provider-native multi-agent orchestration paths')
    expect(payload.prompt).toContain('RECALL')
    expect(payload.prompt).toContain('subThreadId')
    expect(payload.prompt).not.toContain('Complete TaskWraith tool list')
  })

  it('omits the Claude delegation preamble in plan mode (read-only sessions)', () => {
    const payload = compose({ provider: 'claude' }, { approvalMode: 'plan' })
    expect(payload.prompt).not.toContain('TaskWraith MCP server')
    expect(payload.prompt).not.toContain('mcp__TaskWraith__delegate_to_subthread')
    expect(payload.prompt).toContain('Do the thing')
  })

  it('omits the Claude delegation preamble for global-scope runs (no workspace)', () => {
    const payload = compose(
      { provider: 'claude', scope: 'global', workspacePath: undefined, workspaceId: undefined },
      {}
    )
    expect(payload.prompt).not.toContain('TaskWraith MCP server')
    expect(payload.prompt).not.toContain('mcp__TaskWraith__delegate_to_subthread')
    expect(payload.prompt).toContain('Do the thing')
  })

  it('uses Claude provider metadata defaults when model input is omitted', () => {
    const payload = compose(
      {
        provider: 'claude',
        providerMetadata: { selectedModelType: 'claude-opus-4-7', approvalMode: 'plan' }
      },
      { selectedModelType: undefined, approvalMode: undefined }
    )
    expect(payload.model).toBe('claude-opus-4-7')
    expect(payload.approvalMode).toBe('plan')
  })

  it('honors context-turn setting 0 by disabling cold-run history injection', () => {
    const payload = compose(
      { provider: 'codex' },
      { selectedModelType: 'cli-default' },
      { chatContextTurns: 0 }
    )
    expect(payload.prompt).not.toContain('Conversation context')
    expect(payload.composer.contextTurnsApplied).toBe(0)
  })

  it('uses only the last configured number of turns for context', () => {
    const messages = Array.from({ length: 6 }, (_, index) => [
      { id: `u${index}`, role: 'user' as const, content: `user-${index}`, timestamp: 't' },
      { id: `a${index}`, role: 'assistant' as const, content: `assistant-${index}`, timestamp: 't' }
    ]).flat()
    const payload = compose(
      { provider: 'codex', messages },
      { selectedModelType: 'cli-default' },
      { chatContextTurns: 2 }
    )
    expect(payload.prompt).not.toContain('user-0')
    expect(payload.prompt).toContain('user-4')
    expect(payload.prompt).toContain('assistant-5')
    expect(payload.composer.contextTurnsApplied).toBe(2)
  })

  it('pairs a slim native Codex resume with a full-context cutover fallback', () => {
    const payload = compose(
      {
        provider: 'codex',
        linkedProviderSessionId: '7b057c8b-33fa-4eca-9efe-3313a83669f4'
      },
      { selectedModelType: 'gpt-5.6-sol' }
    )

    expect(payload.prompt).not.toContain('Conversation context')
    expect(payload.resumeFallbackPrompt).toContain('Conversation context')
    expect(payload.resumeFallbackPrompt).toContain('Previous answer')
  })

  it('caps context turns at twenty from settings', () => {
    const messages = Array.from({ length: 25 }, (_, index) => [
      { id: `u${index}`, role: 'user' as const, content: `user-${index}`, timestamp: 't' },
      { id: `a${index}`, role: 'assistant' as const, content: `assistant-${index}`, timestamp: 't' }
    ]).flat()
    const payload = compose(
      { provider: 'codex', messages },
      { selectedModelType: 'cli-default' },
      { chatContextTurns: 99 }
    )
    expect(payload.prompt).toContain('Conversation context (last 20 turn(s)):')
    expect(payload.prompt).not.toContain('user-0')
    expect(payload.prompt).toContain('user-24')
  })

  it('rejects empty prompts clearly', () => {
    const chat = makeChat()
    const { deps } = makeDeps(chat)
    const service = new ComposerService(deps)
    expect(() =>
      service.composeRun({
        chatId: chat.appChatId,
        provider: chat.provider as ProviderId,
        workspace: '/repo',
        userInput: '   '
      })
    ).toThrow('Prompt is required.')
  })

  it('normalizes image attachment shape by filtering blank paths', () => {
    const payload = compose(
      { provider: 'claude' },
      {
        selectedModelType: 'claude-sonnet-4-6',
        imageAttachments: [
          { id: 'blank', path: '   ', name: 'blank' },
          { id: 'img', path: ' /tmp/mock.jpg ', name: 'mock.jpg' }
        ]
      }
    )
    expect(payload.imagePaths).toEqual(['/tmp/mock.jpg'])
  })

  it('preserves runtime profile and handoff identifiers on the payload', () => {
    const payload = compose(
      { provider: 'codex' },
      {
        selectedModelType: 'gpt-5.5',
        runtimeProfileId: 'profile-1',
        handoffSourceRunId: 'source-run-1'
      }
    )
    expect(payload.runtimeProfileId).toBe('profile-1')
    expect(payload.handoffSourceRunId).toBe('source-run-1')
  })
})

describe('composeRun effectivePermissions (single-run read-only enforcement)', () => {
  it('populates read-only effectivePermissions for a plan-mode run', () => {
    const payload = compose({}, { approvalMode: 'plan' })
    // The canonical permissions must be present so isReadOnlyBlockedTool() + the
    // YOLO read-only suppression actually engage on the single-run path.
    expect(payload.effectivePermissions).toBeDefined()
    expect(payload.effectivePermissions?.readOnly).toBe(true)
    expect(payload.effectivePermissions?.presetId).toBe('read_only')
    // read_only preset hard-denies the mutating services.
    expect(payload.effectivePermissions?.agenticServices.shellCommands).toBe('deny')
    expect(payload.effectivePermissions?.agenticServices.fileChanges).toBe('deny')
  })

  it('populates signed effectivePermissions for non-read-only runs', () => {
    const defaultPayload = compose({}, { approvalMode: 'default' })
    expect(defaultPayload.effectivePermissions?.readOnly).toBe(false)
    expect(defaultPayload.effectivePermissions?.presetId).toBe('default')

    const workspaceWritePayload = compose(
      { providerMetadata: { approvalMode: 'auto_edit' } },
      { approvalMode: 'auto_edit', appRunId: 'run-workspace-write' }
    )
    expect(workspaceWritePayload.effectivePermissions?.readOnly).toBe(false)
    expect(workspaceWritePayload.effectivePermissions?.presetId).toBe('workspace_write')
    expect(workspaceWritePayload.effectivePermissions?.agenticServices.shellCommands).toBe('allow')
    expect(workspaceWritePayload.effectivePermissions?.agenticServices.fileChanges).toBe('allow')

    const staleFullAccessPayload = compose(
      { providerMetadata: { approvalMode: 'auto_edit' } },
      {
        approvalMode: 'auto_edit',
        permissionPresetId: 'full_access',
        appRunId: 'run-full-access'
      }
    )
    expect(staleFullAccessPayload.effectivePermissions?.readOnly).toBe(false)
    expect(staleFullAccessPayload.effectivePermissions?.presetId).toBe('workspace_write')
    // Non-durable Full Access clamps to Workspace Write (auto-allow shell/file
    // for the run; sandbox drop still requires durable full_access + trust).
    expect(staleFullAccessPayload.effectivePermissions?.agenticServices.shellCommands).toBe(
      'allow'
    )

    const trustedChat = makeChat({ providerMetadata: { approvalMode: 'auto_edit' } })
    const { deps } = makeDeps(trustedChat)
    const trusted = vi.fn(() => true)
    const trustedService = new ComposerService({
      ...deps,
      isTrustedSessionGranted: trusted
    })
    const fullAccessPayload = trustedService.composeRun({
      chatId: trustedChat.appChatId,
      provider: trustedChat.provider as ProviderId,
      workspace: trustedChat.workspacePath,
      userInput: 'Do the thing',
      selectedModelType: 'cli-default',
      approvalMode: 'auto_edit',
      permissionPresetId: 'full_access',
      appRunId: 'run-full-access'
    })
    expect(fullAccessPayload.effectivePermissions?.readOnly).toBe(false)
    expect(fullAccessPayload.effectivePermissions?.presetId).toBe('full_access')
    expect(fullAccessPayload.effectivePermissions?.agenticServices.shellCommands).toBe('allow')
    expect(trusted).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: trustedChat.appChatId,
        provider: DEFAULT_PROVIDER,
        workspacePath: trustedChat.workspacePath
      })
    )
  })

  it('runs GA GPT-5.6 interactive runs with full user-chosen permissions (5.5 parity)', () => {
    const payload = compose(
      { provider: 'codex', providerMetadata: { approvalMode: 'auto_edit' } },
      {
        provider: 'codex',
        selectedModelType: 'gpt-5.6-sol',
        approvalMode: 'auto_edit',
        appRunId: 'run-preview'
      }
    )

    expect(payload.approvalMode).toBe('auto_edit')
    expect(payload.effectivePermissions?.readOnly).toBe(false)
    expect(payload.effectivePermissions?.approvalMode).toBe('auto_edit')
    expect(payload.effectivePermissions?.agenticServices.shellCommands).toBe('allow')
    expect(payload.effectivePermissions?.agenticServices.fileChanges).toBe('allow')
    expect(payload.effectivePermissions?.agenticServices.mcpTools).toBe('ask')
    expect(payload.effectivePermissions?.networkAccess).toBe('allow')
  })
})

describe('composeRun frozen execution-graph permission posture', () => {
  const frozenGrant = makeGrant({
    id: 'graph-grant',
    path: '/outside/graph-input.txt'
  })
  const frozenWorkspaceWrite: EffectiveRunPermissions = {
    presetId: 'workspace_write',
    approvalMode: 'auto_edit',
    agenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'workspace',
      externalPublish: 'deny',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      sketchCanvas: 'allow',
      meshCanvas: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'deny',
      mediaRecording: 'deny',
      canvasEval: 'ask'
    },
    networkAccess: 'deny',
    externalPathGrants: [frozenGrant],
    workspaceGrantServiceIds: [],
    readOnly: false
  }

  it('uses the exact main-resolved posture for a graph-owned appRunId', () => {
    const chat = makeChat({ provider: 'codex' })
    const { deps } = makeDeps(chat)
    const resolveFrozenPermissionPosture = vi.fn(() => ({
      approvalMode: 'auto_edit',
      workflowMode: 'normal' as const,
      effectivePermissions: frozenWorkspaceWrite
    }))
    const isTrustedSessionGranted = vi.fn(() => true)
    const service = new ComposerService({
      ...deps,
      resolveFrozenPermissionPosture,
      isTrustedSessionGranted
    })

    const payload = service.composeRun({
      chatId: chat.appChatId,
      appRunId: 'graph-run-1',
      provider: 'codex',
      workspace: '/repo',
      userInput: 'Run the graph step',
      selectedModelType: 'gpt-5.5',
      runtimeProfileId: 'profile-1',
      approvalMode: 'plan',
      workflowMode: 'plan',
      permissionPresetId: 'full_access',
      externalPathGrants: [makeGrant({ id: 'renderer-grant', path: '/outside/untrusted.txt' })]
    })

    expect(resolveFrozenPermissionPosture).toHaveBeenCalledTimes(1)
    expect(resolveFrozenPermissionPosture).toHaveBeenCalledWith({
      appRunId: 'graph-run-1',
      provider: 'codex',
      scope: 'workspace',
      chatId: chat.appChatId,
      workspacePath: '/repo',
      runtimeProfileId: 'profile-1'
    })
    expect(payload.approvalMode).toBe('auto_edit')
    expect(payload.workflowMode).toBe('normal')
    expect(payload.effectivePermissions).toBe(frozenWorkspaceWrite)
    expect(payload.externalPathGrants).toEqual([frozenGrant])
    expect(payload.prompt).toContain('/outside/graph-input.txt')
    expect(payload.prompt).not.toContain('/outside/untrusted.txt')
    expect(isTrustedSessionGranted).not.toHaveBeenCalled()
  })

  it('does not consult the graph resolver for an ordinary run without an appRunId', () => {
    const chat = makeChat({ provider: 'codex' })
    const { deps } = makeDeps(chat)
    const resolveFrozenPermissionPosture = vi.fn(() => ({
      approvalMode: 'auto_edit',
      workflowMode: 'normal' as const,
      effectivePermissions: frozenWorkspaceWrite
    }))
    const service = new ComposerService({ ...deps, resolveFrozenPermissionPosture })

    const payload = service.composeRun({
      chatId: chat.appChatId,
      provider: 'codex',
      workspace: '/repo',
      userInput: 'Run normally',
      selectedModelType: 'gpt-5.5',
      approvalMode: 'default'
    })

    expect(resolveFrozenPermissionPosture).not.toHaveBeenCalled()
    expect(payload.approvalMode).toBe('default')
    expect(payload.effectivePermissions?.presetId).toBe('default')
    expect(payload.effectivePermissions).not.toBe(frozenWorkspaceWrite)
  })

  it('keeps scheduled runs on the unattended path even when they carry an appRunId', () => {
    const chat = makeChat({ provider: 'codex', providerMetadata: { approvalMode: 'auto_edit' } })
    const { deps } = makeDeps(chat)
    const resolveFrozenPermissionPosture = vi.fn(() => ({
      approvalMode: 'auto_edit',
      workflowMode: 'normal' as const,
      effectivePermissions: frozenWorkspaceWrite
    }))
    const service = new ComposerService({ ...deps, resolveFrozenPermissionPosture })

    const payload = service.composeRun({
      chatId: chat.appChatId,
      appRunId: 'scheduled-run-1',
      scheduledTaskId: 'scheduled-task-1',
      provider: 'codex',
      workspace: '/repo',
      userInput: 'Run unattended',
      selectedModelType: 'gpt-5.5',
      approvalMode: 'auto_edit'
    })

    expect(resolveFrozenPermissionPosture).not.toHaveBeenCalled()
    expect(payload.approvalMode).toBe('plan')
    expect(payload.effectivePermissions?.readOnly).toBe(true)
  })

  it('rejects a writable frozen posture if the selected model is preview-risk', () => {
    const chat = makeChat({ provider: 'claude' })
    const { deps } = makeDeps(chat)
    const resolveFrozenPermissionPosture = vi.fn(() => ({
      approvalMode: 'auto_edit',
      workflowMode: 'normal' as const,
      effectivePermissions: frozenWorkspaceWrite
    }))
    const service = new ComposerService({ ...deps, resolveFrozenPermissionPosture })

    expect(() =>
      service.composeRun({
        chatId: chat.appChatId,
        appRunId: 'graph-preview-run',
        provider: 'claude',
        workspace: '/repo',
        userInput: 'Run the graph step',
        selectedModelType: 'preview:anthropic:claude-fable-5',
        approvalMode: 'auto_edit'
      })
    ).toThrow(
      'Execution graph permission posture cannot be applied after the model became preview-risk.'
    )
  })
})

describe('composeRun ↔ normalize posture clamp contract', () => {
  const SECRET = Buffer.from('f'.repeat(64), 'hex')
  const SENTINEL_READONLY: EffectiveRunPermissions = {
    presetId: 'read_only',
    approvalMode: 'plan',
    agenticServices: {
      shellCommands: 'deny',
      fileChanges: 'deny',
      externalPublish: 'deny',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      sketchCanvas: 'deny',
      meshCanvas: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'deny',
      mediaRecording: 'deny',
      canvasEval: 'ask'
    },
    networkAccess: 'deny',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: true
  }

  function composeSigned(
    inputOverrides: Record<string, unknown>,
    chatOverrides: Partial<ChatRecord> = {}
  ): ComposerRunPayload {
    const chat = makeChat(chatOverrides)
    const { deps } = makeDeps(chat)
    const service = new ComposerService({
      ...deps,
      signRunPermissionPosture: (mode, perms, context) =>
        signRunPermissionPosture(SECRET, mode, perms, context)
    })
    return service.composeRun({
      chatId: chat.appChatId,
      appRunId: 'run-signed',
      provider: chat.provider as ProviderId,
      workspace: chat.workspacePath,
      userInput: 'Do the thing',
      selectedModelType: 'cli-default',
      approvalMode: 'default',
      ...inputOverrides
    })
  }

  const clampDeps = {
    verify: (
      mode: string | null | undefined,
      perms: EffectiveRunPermissions | null | undefined,
      sig: string | null | undefined,
      context?: Parameters<typeof verifyRunPermissionPosture>[4]
    ) => verifyRunPermissionPosture(SECRET, mode, perms, sig, context),
    reDeriveReadOnly: () => SENTINEL_READONLY,
    reDeriveDefault: (): EffectiveRunPermissions => ({
      ...SENTINEL_READONLY,
      presetId: 'default',
      approvalMode: 'default',
      readOnly: false
    })
  }

  const payloadContext = (payload: ComposerRunPayload) => ({
    provider: payload.provider,
    scope: payload.scope,
    appRunId: payload.appRunId,
    appChatId: payload.appChatId,
    prompt: payload.prompt,
    workflowMode: payload.workflowMode,
    runtimeProfileId: payload.runtimeProfileId
  })

  it('re-resolves selected Project references and binds the exact context into the run signature', () => {
    const chat = makeChat({ provider: 'codex' })
    const { deps, store } = makeDeps(chat)
    store.getProjects = () => [
      {
        schemaVersion: 1,
        id: 'project-a',
        name: 'Alpha',
        icon: { iconKind: 'seed', seed: 'alpha' },
        hue: 1,
        parentId: null,
        order: 1,
        memberChatIds: [chat.appChatId],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    store.getProjectReferences = () => [
      {
        id: 'reference-a',
        projectId: 'project-a',
        kind: 'file',
        locator: '/repo/brief.txt',
        title: 'Brief',
        provenance: { addedBy: 'user', addedAt: 1 },
        contextPolicy: 'available',
        updatedAt: 1
      }
    ]
    const service = new ComposerService({
      ...deps,
      signRunPermissionPosture: (mode, perms, context) =>
        signRunPermissionPosture(SECRET, mode, perms, context)
    })

    const payload = service.composeRun({
      chatId: chat.appChatId,
      appRunId: 'run-reference-context',
      provider: 'codex',
      workspace: '/repo',
      userInput: 'Use the brief',
      selectedModelType: 'cli-default',
      approvalMode: 'default',
      projectReferenceContextSelection: {
        schemaVersion: 1,
        projectId: 'project-a',
        referenceIds: ['reference-a']
      }
    })

    expect(payload.projectReferenceContext).toEqual({
      schemaVersion: 1,
      projectId: 'project-a',
      projectName: 'Alpha',
      references: [
        {
          id: 'reference-a',
          kind: 'file',
          title: 'Brief',
          locator: '/repo/brief.txt',
          access: 'workspace'
        }
      ]
    })
    expect(payload.composer.projectReferenceContext).toEqual(payload.projectReferenceContext)
    expect(payload.prompt).toContain('<project_reference_context>')
    expect(payload.prompt).toContain('Selection grants no new filesystem or network access.')
    expect(payload.prompt).toContain('/repo/brief.txt')
    expect(
      verifyRunPermissionPosture(
        SECRET,
        payload.approvalMode,
        payload.effectivePermissions,
        payload.effectivePermissionsSignature,
        runPostureContextFromPayload(payload)
      )
    ).toBe(true)

    const tampered = {
      ...payload,
      projectReferenceContext: {
        ...payload.projectReferenceContext!,
        references: [
          {
            ...payload.projectReferenceContext!.references[0],
            locator: '/repo/other.txt'
          }
        ]
      }
    }
    expect(
      verifyRunPermissionPosture(
        SECRET,
        tampered.approvalMode,
        tampered.effectivePermissions,
        tampered.effectivePermissionsSignature,
        runPostureContextFromPayload(tampered)
      )
    ).toBe(false)
  })

  it('stamps a verifiable signature on a plan run that survives the clamp byte-for-byte', () => {
    const payload = composeSigned({ approvalMode: 'plan' })
    expect(payload.effectivePermissionsSignature).toBeTruthy()
    const clamped = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: payload.approvalMode,
        effectivePermissions: payload.effectivePermissions,
        signature: payload.effectivePermissionsSignature,
        context: payloadContext(payload)
      },
      clampDeps
    )
    expect(clamped.downgraded).toBe(false)
    expect(clamped.approvalMode).toBe('plan')
    expect(clamped.effectivePermissions).toEqual(payload.effectivePermissions)
  })

  it('binds approvalMode and effectivePermissions for non-plan runs', () => {
    const payload = composeSigned(
      { approvalMode: 'auto_edit' },
      { providerMetadata: { approvalMode: 'auto_edit' } }
    )
    expect(payload.effectivePermissions?.presetId).toBe('workspace_write')
    expect(payload.effectivePermissionsSignature).toBeTruthy()
    const clamped = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: payload.approvalMode,
        effectivePermissions: payload.effectivePermissions,
        signature: payload.effectivePermissionsSignature,
        context: payloadContext(payload)
      },
      clampDeps
    )
    expect(clamped.approvalMode).toBe('auto_edit')
    expect(clamped.effectivePermissions).toEqual(payload.effectivePermissions)
  })

  it('binds workflowMode so a read-only recon payload cannot be flipped into plan', () => {
    const payload = composeSigned({ approvalMode: 'plan', workflowMode: 'normal' })
    expect(payload.approvalMode).toBe('plan')
    expect(payload.workflowMode).toBe('normal')
    expect(payload.effectivePermissions?.readOnly).toBe(true)

    const clamped = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: payload.approvalMode,
        effectivePermissions: payload.effectivePermissions,
        signature: payload.effectivePermissionsSignature,
        context: { ...payloadContext(payload), workflowMode: 'plan' }
      },
      clampDeps
    )
    expect(clamped.downgraded).toBe(true)
    expect(clamped.reason).toBe('invalid-posture-signature')
    expect(clamped.approvalMode).toBe('plan')
    expect(clamped.effectivePermissions).toEqual(SENTINEL_READONLY)
  })

  it('rejects replaying a composed signature onto a different run context', () => {
    const payload = composeSigned(
      { approvalMode: 'auto_edit' },
      { providerMetadata: { approvalMode: 'auto_edit' } }
    )
    const clamped = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: payload.approvalMode,
        effectivePermissions: payload.effectivePermissions,
        signature: payload.effectivePermissionsSignature,
        context: { ...payloadContext(payload), appRunId: 'run-other' }
      },
      clampDeps
    )
    expect(clamped.downgraded).toBe(true)
    expect(clamped.reason).toBe('invalid-posture-signature')
    expect(clamped.approvalMode).toBe('plan')
    expect(clamped.effectivePermissions).toEqual(SENTINEL_READONLY)
  })

  it('caps renderer-requested auto_edit to the trusted persisted chat posture before signing', () => {
    const payload = composeSigned({ approvalMode: 'auto_edit' })
    expect(payload.approvalMode).toBe('default')
    expect(payload.effectivePermissions?.presetId).toBe('default')
    expect(payload.effectivePermissionsSignature).toBeTruthy()
    const clamped = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: payload.approvalMode,
        effectivePermissions: payload.effectivePermissions,
        signature: payload.effectivePermissionsSignature,
        context: payloadContext(payload)
      },
      clampDeps
    )
    expect(clamped.downgraded).toBe(false)
    expect(clamped.approvalMode).toBe('default')
  })

  it('downgrades to read-only when the renderer inflates the composed posture', () => {
    const payload = composeSigned({ approvalMode: 'plan' })
    // Renderer tampers the round-tripped payload: keeps the plan-run signature
    // but swaps in an over-permissive effectivePermissions object.
    const clamped = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: 'auto_edit',
        effectivePermissions: {
          ...SENTINEL_READONLY,
          presetId: 'full_access',
          approvalMode: 'auto_edit',
          agenticServices: {
            shellCommands: 'allow',
            fileChanges: 'allow',
            externalPublish: 'ask',
            mcpTools: 'allow',
            subThreadDelegation: 'allow',
            canvasInteraction: 'ask',
            sketchCanvas: 'allow',
            meshCanvas: 'ask',
            crossThreadRead: 'ask',
            threadMessage: 'ask',
            mediaEditing: 'allow',
            mediaRecording: 'deny',
            canvasEval: 'ask'
          },
          networkAccess: 'allow',
          readOnly: false
        },
        signature: payload.effectivePermissionsSignature,
        context: payloadContext(payload)
      },
      clampDeps
    )
    expect(clamped.downgraded).toBe(true)
    expect(clamped.reason).toBe('invalid-posture-signature')
    expect(clamped.approvalMode).toBe('plan')
    expect(clamped.effectivePermissions).toEqual(SENTINEL_READONLY)
  })
})

describe('composeRun unattended posture clamp (scheduled/workflow runs)', () => {
  it('FORCES plan for an unattended run even when the chat’s stored mode is auto_edit (trusted-floor poisoning)', () => {
    // The chat persisted auto_edit, so capRequestedApprovalMode’s trusted ceiling is
    // itself auto_edit and the run carries an appRunId — i.e. every pre-existing cap
    // is a no-op. The scheduledTaskId clamp must still force a safe posture.
    const payload = compose(
      { provider: 'codex', providerMetadata: { approvalMode: 'auto_edit' } },
      { provider: 'codex', approvalMode: 'auto_edit', appRunId: 'run-1', scheduledTaskId: 'task-1' }
    )
    expect(payload.approvalMode).toBe('plan')
    // Read-only permissions must be POPULATED (forced before the plan-population
    // block) — not read-only in name only.
    expect(payload.effectivePermissions?.readOnly).toBe(true)
    expect(payload.effectivePermissions?.presetId).toBe('read_only')
  })

  it('clears externalPathGrants for the forced-plan unattended run (interactive contrast keeps them)', () => {
    const grant = makeGrant({
      provider: 'codex',
      access: 'write',
      kind: 'directory',
      path: '/outside'
    })
    // Interactive (no scheduledTaskId): the grant survives normalization.
    const interactive = compose(
      { provider: 'codex', providerMetadata: { approvalMode: 'auto_edit' } },
      {
        provider: 'codex',
        approvalMode: 'auto_edit',
        appRunId: 'run-1',
        externalPathGrants: [grant]
      }
    )
    expect((interactive.externalPathGrants ?? []).length).toBeGreaterThan(0)
    // The SAME run as a scheduled occurrence is forced to plan AND its grants cleared.
    const unattended = compose(
      { provider: 'codex', providerMetadata: { approvalMode: 'auto_edit' } },
      {
        provider: 'codex',
        approvalMode: 'auto_edit',
        appRunId: 'run-1',
        scheduledTaskId: 'task-1',
        externalPathGrants: [grant]
      }
    )
    expect(unattended.approvalMode).toBe('plan')
    expect(unattended.externalPathGrants).toEqual([])
  })

  it('leaves an INTERACTIVE elevated run untouched (clamp is scoped strictly to scheduledTaskId)', () => {
    const payload = compose(
      { provider: 'codex', providerMetadata: { approvalMode: 'auto_edit' } },
      { provider: 'codex', approvalMode: 'auto_edit', appRunId: 'run-1' }
    )
    expect(payload.approvalMode).toBe('auto_edit')
  })
})

describe('composeRun unattended ELEVATION (P2 verified ack honoring)', () => {
  const SECRET = Buffer.from('1234567890abcdef'.repeat(4), 'hex')

  function composeUnattended(
    elevation: { level: 'default' | 'full_access'; mode: string } | null,
    chatOverrides: Partial<ChatRecord> = {
      provider: 'codex',
      providerMetadata: { approvalMode: 'auto_edit' }
    },
    inputOverrides: Record<string, unknown> = {},
    settingsOverrides: Partial<AppSettings> = {}
  ): ComposerRunPayload {
    const chat = makeChat(chatOverrides)
    const { deps } = makeDeps(chat, settingsOverrides)
    const service = new ComposerService({
      ...deps,
      signRunPermissionPosture: (mode, perms, context) =>
        signRunPermissionPosture(SECRET, mode, perms, context),
      resolveUnattendedElevation: () =>
        elevation
          ? {
              ack: {
                level: elevation.level,
                acknowledgedAt: '2026-06-24T00:00:00.000Z',
                acknowledgedApprovalMode: elevation.mode,
                authorityDigest: 'a'.repeat(64),
                signature: 'verified-by-the-dep'
              },
              templateApprovalMode: elevation.mode
            }
          : null
    })
    return service.composeRun({
      chatId: chat.appChatId,
      provider: 'codex',
      workspace: chat.workspacePath,
      userInput: 'Run the scheduled occurrence.',
      selectedModelType: 'gpt-5.5',
      approvalMode: 'auto_edit',
      appRunId: 'run-sched',
      scheduledTaskId: 'task-1',
      ...inputOverrides
    })
  }

  it('verified full_access → auto_edit + workspace_write perms + grants KEPT + signed', () => {
    const grant = makeGrant({
      provider: 'codex',
      access: 'write',
      kind: 'directory',
      path: '/outside',
      duration: 'workspace'
    })
    const payload = composeUnattended({ level: 'full_access', mode: 'auto_edit' }, undefined, {
      externalPathGrants: [grant]
    })
    expect(payload.approvalMode).toBe('auto_edit')
    expect(payload.effectivePermissions?.presetId).toBe('workspace_write')
    expect(payload.effectivePermissions?.readOnly).toBe(false)
    // Unattended elevation force-denies network egress (no exfiltration on a loop).
    expect(payload.effectivePermissions?.networkAccess).toBe('deny')
    // Elevated ⇒ approvalMode !== 'plan' ⇒ the grant-clear is skipped.
    expect(payload.externalPathGrants).toEqual([grant])
    expect(payload.prompt).toContain('/outside')
    // The posture is SIGNED (honest, verifiable) — not undefined.
    expect(payload.effectivePermissionsSignature).toBeTruthy()
    expect(
      verifyRunPermissionPosture(
        SECRET,
        payload.approvalMode,
        payload.effectivePermissions,
        payload.effectivePermissionsSignature,
        {
          provider: payload.provider,
          scope: payload.scope,
          appRunId: payload.appRunId,
          appChatId: payload.appChatId,
          prompt: payload.prompt,
          workflowMode: payload.workflowMode,
          runtimeProfileId: payload.runtimeProfileId
        }
      )
    ).toBe(true)
  })

  it('honors a verified full-access ack for GA GPT-5.6 scheduled runs (5.5 parity)', () => {
    const payload = composeUnattended({ level: 'full_access', mode: 'auto_edit' }, undefined, {
      selectedModelType: 'gpt-5.6-sol'
    })

    expect(payload.approvalMode).toBe('auto_edit')
    expect(payload.effectivePermissions?.presetId).toBe('workspace_write')
    expect(payload.effectivePermissions?.readOnly).toBe(false)
    expect(payload.effectivePermissions?.agenticServices.shellCommands).toBe('allow')
    expect(payload.effectivePermissions?.agenticServices.fileChanges).toBe('allow')
  })

  it('rechecks current service policy for a verified elevated scheduled run', () => {
    const revokedServices = {
      ...makeSettings().agenticServices,
      shellCommands: 'deny' as const
    }
    const payload = composeUnattended(
      { level: 'full_access', mode: 'auto_edit' },
      undefined,
      {},
      { agenticServices: revokedServices }
    )

    expect(payload.approvalMode).toBe('auto_edit')
    expect(payload.effectivePermissions?.presetId).toBe('workspace_write')
    expect(payload.effectivePermissions?.readOnly).toBe(false)
    expect(payload.effectivePermissions?.agenticServices.shellCommands).toBe('deny')
    expect(payload.effectivePermissions?.networkAccess).toBe('deny')
    expect(
      verifyRunPermissionPosture(
        SECRET,
        payload.approvalMode,
        payload.effectivePermissions,
        payload.effectivePermissionsSignature,
        {
          provider: payload.provider,
          scope: payload.scope,
          appRunId: payload.appRunId,
          appChatId: payload.appChatId,
          prompt: payload.prompt,
          workflowMode: payload.workflowMode,
          runtimeProfileId: payload.runtimeProfileId
        }
      )
    ).toBe(true)
  })

  it('verified default → default preset', () => {
    const payload = composeUnattended(
      { level: 'default', mode: 'default' },
      { provider: 'codex', providerMetadata: { approvalMode: 'default' } }
    )
    expect(payload.approvalMode).toBe('default')
    expect(payload.effectivePermissions?.presetId).toBe('default')
    expect(payload.effectivePermissions?.readOnly).toBe(false)
  })

  it('no ack (resolve → null) → plan + read_only (P1 regression); tampered/stale surface here as null too', () => {
    const payload = composeUnattended(null)
    expect(payload.approvalMode).toBe('plan')
    expect(payload.effectivePermissions?.presetId).toBe('read_only')
    expect(payload.effectivePermissions?.readOnly).toBe(true)
  })
})
