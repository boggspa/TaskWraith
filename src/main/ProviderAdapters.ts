import type {
  ProviderAdapterDescriptor,
  ProviderCapabilityContract,
  ProviderId
} from './store/types'

export interface ProviderRunContext<TPayload = unknown, TEvent = unknown> {
  event: TEvent
  payload: TPayload
}

export interface ProviderCapabilityRequest {
  workspacePath?: string
  approvalMode?: string
}

export interface ProviderAdapter<
  TPayload = unknown,
  TEvent = unknown
> extends ProviderAdapterDescriptor {
  run(context: ProviderRunContext<TPayload, TEvent>): Promise<void>
  cancel(runId?: string): Promise<boolean>
  getStatus(): Promise<unknown>
  getMcpStatus(): Promise<unknown>
  getCapabilityContract(request?: ProviderCapabilityRequest): Promise<ProviderCapabilityContract>
}

export class ProviderAdapterRegistry<TPayload = unknown, TEvent = unknown> {
  private adapters = new Map<ProviderId, ProviderAdapter<TPayload, TEvent>>()

  constructor(adapters: ProviderAdapter<TPayload, TEvent>[]) {
    for (const adapter of adapters) {
      this.register(adapter)
    }
  }

  register(adapter: ProviderAdapter<TPayload, TEvent>): void {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(`Provider adapter already registered: ${adapter.provider}`)
    }
    this.adapters.set(adapter.provider, adapter)
  }

  get(provider: ProviderId): ProviderAdapter<TPayload, TEvent> | undefined {
    return this.adapters.get(provider)
  }

  require(provider: ProviderId): ProviderAdapter<TPayload, TEvent> {
    const adapter = this.get(provider)
    if (!adapter) {
      throw new Error(`Provider adapter is not registered: ${provider}`)
    }
    return adapter
  }

  list(): ProviderAdapter<TPayload, TEvent>[] {
    return [...this.adapters.values()]
  }

  descriptors(): ProviderAdapterDescriptor[] {
    return this.list().map((adapter) => providerAdapterDescriptor(adapter))
  }
}

export function providerAdapterDescriptor(
  adapter: ProviderAdapterDescriptor
): ProviderAdapterDescriptor {
  const descriptor: ProviderAdapterDescriptor = {
    provider: adapter.provider,
    label: adapter.label,
    transport: adapter.transport,
    runChannel: adapter.runChannel,
    capabilitySource: adapter.capabilitySource,
    features: { ...adapter.features },
    capabilities: {
      ...adapter.capabilities,
      approvalModes: [...adapter.capabilities.approvalModes],
      speedTiers: [...adapter.capabilities.speedTiers]
    }
  }
  if (adapter.capabilityCaveats) {
    descriptor.capabilityCaveats = adapter.capabilityCaveats.map((caveat) => ({ ...caveat }))
  }
  return descriptor
}

export function createProviderAdapterRegistry<TPayload = unknown, TEvent = unknown>(
  adapters: ProviderAdapter<TPayload, TEvent>[]
): ProviderAdapterRegistry<TPayload, TEvent> {
  return new ProviderAdapterRegistry(adapters)
}

export function providerLabel(provider: ProviderId): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'ollama') return 'Ollama'
  return 'Gemini'
}

export function defaultProviderDescriptor(provider: ProviderId): ProviderAdapterDescriptor {
  if (provider === 'codex') {
    return {
      provider,
      label: providerLabel(provider),
      transport: 'codex-app-server',
      runChannel: 'run-agent',
      capabilitySource: 'mixed',
      features: {
        persistentSessions: true,
        appManagedApprovals: true,
        workspaceGrants: true,
        agentBenchMcpBridge: false,
        providerManagedMcp: true,
        nativeThreadTools: true,
        hostCommandFallback: true
      },
      capabilities: {
        approvalModes: ['default'],
        reasoningEffort: true,
        speedTiers: ['flash', 'flash-lite'],
        imageAttachments: true,
        contextInjection: true,
        sessionResumption: true,
        perThreadMcp: false,
        assistantTextStreaming: 'token'
      }
    }
  }
  if (provider === 'gemini') {
    return {
      provider,
      label: providerLabel(provider),
      transport: 'gemini-cli',
      runChannel: 'run-agent',
      capabilitySource: 'bridge',
      features: {
        persistentSessions: true,
        appManagedApprovals: true,
        workspaceGrants: true,
        agentBenchMcpBridge: true,
        providerManagedMcp: false,
        nativeThreadTools: false,
        hostCommandFallback: false
      },
      capabilities: {
        approvalModes: ['default', 'plan'],
        reasoningEffort: false,
        speedTiers: [],
        imageAttachments: true,
        contextInjection: true,
        sessionResumption: true,
        perThreadMcp: true,
        assistantTextStreaming: 'token'
      }
    }
  }
  if (provider === 'kimi') {
    return {
      provider,
      label: providerLabel(provider),
      transport: 'kimi-wire-or-cli',
      runChannel: 'run-agent',
      capabilitySource: 'mixed',
      features: {
        persistentSessions: true,
        appManagedApprovals: true,
        workspaceGrants: false,
        agentBenchMcpBridge: false,
        providerManagedMcp: true,
        nativeThreadTools: false,
        hostCommandFallback: false
      },
      capabilities: {
        approvalModes: ['default'],
        reasoningEffort: false,
        speedTiers: ['fast'],
        imageAttachments: true,
        contextInjection: true,
        sessionResumption: true,
        perThreadMcp: false,
        assistantTextStreaming: 'token'
      }
    }
  }
  if (provider === 'grok') {
    // First-class Grok. G6 landed persistent sessions (headless `--resume`);
    // G5c landed file-write mode (`acceptEdits` + Edit/Write, diff/PR-reviewed —
    // `approvalModes: ['plan','default']`). Still NO app-managed per-tool
    // approval cards. The full TaskWraith MCP bridge is mode-scoped: read-only
    // runs stay safe-subset/provider-delegated unless separately enabled, while
    // write-capable ACP runs auto-inject the governed bridge. Without this
    // branch grok would inherit the Claude default below, advertising
    // providerManagedMcp it does not have.
    return {
      provider,
      label: providerLabel(provider),
      transport: 'grok-cli',
      runChannel: 'run-agent',
      capabilitySource: 'provider',
      features: {
        persistentSessions: true,
        appManagedApprovals: false,
        workspaceGrants: false,
        agentBenchMcpBridge: false,
        providerManagedMcp: false,
        nativeThreadTools: false,
        hostCommandFallback: false
      },
      capabilities: {
        approvalModes: ['plan', 'default'],
        reasoningEffort: true,
        speedTiers: [],
        imageAttachments: false,
        contextInjection: false,
        sessionResumption: true,
        perThreadMcp: false,
        assistantTextStreaming: 'token'
      },
      capabilityCaveats: [
        {
          id: 'grok-taskwraith-bridge-write-mode-only',
          severity: 'info',
          capability: 'taskwraithMcpBridge',
          title: 'TaskWraith MCP bridge is mode-scoped',
          message:
            'Read-only Grok runs do not advertise the full TaskWraith MCP bridge by default; write-capable Grok ACP runs auto-inject a scoped bridge so side effects route through TaskWraith approvals and path checks.'
        }
      ]
    }
  }
  if (provider === 'cursor') {
    // First-class Cursor (Composer 2.5 + Cursor Grok 4.5). Transport is the
    // cursor-agent headless
    // stream-json CLI; sessions resume via --resume. CR6 landed write mode
    // (`approvalModes: ['plan','default']`): 'plan' = read-only (--mode plan),
    // 'default' = file-write contained by a workspace-local deny-list (native
    // shell denied; edits diff/PR-reviewed — Grok-parity). NO app-managed
    // per-tool approval cards. The full TaskWraith MCP bridge is mode-scoped:
    // read-only runs stay provider-delegated unless separately enabled, while
    // write-capable runs auto-inject the governed bridge. Without this branch
    // cursor would inherit the Claude default below, advertising capabilities it
    // does not have.
    return {
      provider,
      label: providerLabel(provider),
      transport: 'cursor-cli',
      runChannel: 'run-agent',
      capabilitySource: 'provider',
      features: {
        persistentSessions: true,
        appManagedApprovals: false,
        workspaceGrants: false,
        agentBenchMcpBridge: false,
        providerManagedMcp: false,
        nativeThreadTools: false,
        hostCommandFallback: false
      },
      capabilities: {
        approvalModes: ['plan', 'default'],
        reasoningEffort: true,
        speedTiers: ['fast'],
        imageAttachments: false,
        contextInjection: false,
        sessionResumption: true,
        perThreadMcp: false,
        assistantTextStreaming: 'token'
      },
      capabilityCaveats: [
        {
          id: 'cursor-taskwraith-bridge-write-mode-only',
          severity: 'info',
          capability: 'taskwraithMcpBridge',
          title: 'TaskWraith MCP bridge is mode-scoped',
          message:
            'Read-only Cursor runs do not advertise the full TaskWraith MCP bridge by default; write-capable Cursor runs auto-inject a scoped broker so side effects route through TaskWraith approvals and path checks.'
        }
      ]
    }
  }
  if (provider === 'ollama') {
    return {
      provider,
      label: providerLabel(provider),
      transport: 'ollama-http',
      runChannel: 'run-agent',
      capabilitySource: 'taskwraith',
      features: {
        persistentSessions: false,
        appManagedApprovals: true,
        workspaceGrants: false,
        agentBenchMcpBridge: false,
        providerManagedMcp: false,
        nativeThreadTools: false,
        hostCommandFallback: false
      },
      capabilities: {
        approvalModes: ['plan'],
        reasoningEffort: false,
        speedTiers: [],
        imageAttachments: false,
        contextInjection: true,
        sessionResumption: false,
        perThreadMcp: false,
        assistantTextStreaming: 'token'
      }
    }
  }
  return {
    provider,
    label: providerLabel(provider),
    transport: 'claude-sdk-or-cli',
    runChannel: 'run-agent',
    capabilitySource: 'provider',
    features: {
      persistentSessions: true,
      appManagedApprovals: false,
      workspaceGrants: false,
      agentBenchMcpBridge: false,
      providerManagedMcp: true,
      nativeThreadTools: false,
      hostCommandFallback: false
    },
    capabilities: {
      approvalModes: ['default'],
      reasoningEffort: true,
      speedTiers: ['fast'],
      imageAttachments: true,
      contextInjection: true,
      sessionResumption: true,
      perThreadMcp: false,
      assistantTextStreaming: 'token'
    }
  }
}
