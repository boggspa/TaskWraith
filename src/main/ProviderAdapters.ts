import type {
  ProviderAdapterDescriptor,
  ProviderCapabilityContract,
  ProviderId
} from './store/types'
import { supportsTaskWraithToolGrants } from '../shared/providerToolGrantSupport'

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
  const workspaceGrants = supportsTaskWraithToolGrants(provider)
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
        workspaceGrants,
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
        workspaceGrants,
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
      transport: 'kimi-acp-authenticated-http-mcp',
      runChannel: 'run-agent',
      capabilitySource: 'bridge',
      features: {
        persistentSessions: true,
        appManagedApprovals: true,
        workspaceGrants,
        agentBenchMcpBridge: true,
        providerManagedMcp: false,
        nativeThreadTools: false,
        hostCommandFallback: false
      },
      capabilities: {
        approvalModes: ['default', 'plan'],
        reasoningEffort: false,
        speedTiers: ['fast'],
        imageAttachments: false,
        contextInjection: true,
        sessionResumption: true,
        perThreadMcp: true,
        assistantTextStreaming: 'token'
      },
      capabilityCaveats: [
        {
          id: 'kimi-reviewed-runtime-admission',
          severity: 'warning',
          capability: 'taskwraithMcpBridge',
          title: 'Reviewed runtime admission required',
          message:
            'Managed Kimi turns and native compaction launch only after exact runtime admission, then use a private synthetic cwd and authenticated per-run TaskWraith HTTP MCP gateway. User-owned login/upgrade terminals do not qualify a runtime.'
        }
      ]
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
        // Grok native tools + TaskWraith MCP both route through PermissionService
        // / requestAgenticServiceApproval, so per-provider workspace grants apply.
        workspaceGrants,
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
    // Path B: real ~/.cursor login + contained --sandbox argv. Native tools
    // stay provider-managed; TaskWraith does not mediate per-tool approvals.
    return {
      provider,
      label: providerLabel(provider),
      transport: 'cursor-cli',
      runChannel: 'run-agent',
      capabilitySource: 'provider',
      features: {
        persistentSessions: false,
        appManagedApprovals: false,
        workspaceGrants,
        agentBenchMcpBridge: false,
        providerManagedMcp: true,
        nativeThreadTools: true,
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
          id: 'cursor-sandbox-partial',
          severity: 'info',
          capability: 'approvalModes',
          title: 'Cursor uses native tools under OS sandbox',
          message:
            'Cursor runs are contained by --sandbox enabled (honest partial backstop). TaskWraith does not mediate Cursor per-tool approvals.'
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
        // Local tool loop uses the same PermissionService workspace-grant path.
        workspaceGrants,
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
      // Claude TaskWraith MCP + brokered tools honor per-provider workspace grants.
      workspaceGrants,
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
