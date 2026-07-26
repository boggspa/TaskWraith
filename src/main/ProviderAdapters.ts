import type {
  ProviderAdapterDescriptor,
  ProviderCapabilityContract,
  ProviderId
} from './store/types'
import { PROVIDER_RUN_MANAGEMENT_IDS } from './run/ProviderRunManagementMatrix'

/**
 * Exact adapter-registration baseline. The registry can enforce this set at
 * the production construction site without exposing it as an offer/admission
 * list; conditional and retired identities remain intentionally included.
 */
export const PROVIDER_ADAPTER_REGISTRATION_IDS = PROVIDER_RUN_MANAGEMENT_IDS

export interface ProviderRunContext<TPayload = unknown, TEvent = unknown> {
  event: TEvent
  payload: TPayload
}

export interface ProviderCapabilityRequest {
  workspacePath?: string
  approvalMode?: string
}

export interface ProviderAdapterRegistryOptions {
  /**
   * Require one adapter for every stable provider identity and reject
   * unaccounted identities. Partial registries remain useful in unit tests, so
   * production opts into this assertion explicitly at its construction site.
   */
  requireCompleteProviderSet?: boolean
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

  constructor(
    adapters: ProviderAdapter<TPayload, TEvent>[],
    options: ProviderAdapterRegistryOptions = {}
  ) {
    for (const adapter of adapters) {
      this.register(adapter)
    }
    if (options.requireCompleteProviderSet) {
      this.assertCompleteProviderSet()
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

  private assertCompleteProviderSet(): void {
    const expected = new Set<ProviderId>(PROVIDER_ADAPTER_REGISTRATION_IDS)
    const missing = PROVIDER_ADAPTER_REGISTRATION_IDS.filter(
      (provider) => !this.adapters.has(provider)
    )
    const unaccounted = [...this.adapters.keys()].filter((provider) => !expected.has(provider))
    if (missing.length === 0 && unaccounted.length === 0) return
    const detail = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      unaccounted.length > 0 ? `unaccounted: ${unaccounted.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('; ')
    throw new Error(`Provider adapter registry is incomplete (${detail}).`)
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
  adapters: ProviderAdapter<TPayload, TEvent>[],
  options: ProviderAdapterRegistryOptions = {}
): ProviderAdapterRegistry<TPayload, TEvent> {
  return new ProviderAdapterRegistry(adapters, options)
}

export function providerLabel(provider: ProviderId): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'ollama') return 'Ollama'
  if (provider === 'antigravity') return 'AntiGravity'
  if (provider === 'pi') return 'Pi'
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
      transport: 'kimi-acp-authenticated-http-mcp',
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
    // First-class Grok. Production uses a fresh ACP session for each turn and
    // host-feeds bounded conversation context; the old headless `--resume`
    // descriptor no longer describes the launch path. Write-capable ACP turns
    // can inject the governed bridge, while per-tool approval remains hybrid.
    return {
      provider,
      label: providerLabel(provider),
      transport: 'grok-cli',
      runChannel: 'run-agent',
      capabilitySource: 'provider',
      features: {
        persistentSessions: false,
        appManagedApprovals: false,
        // Grok native tools + TaskWraith MCP both route through PermissionService
        // / requestAgenticServiceApproval, so per-provider workspace grants apply.
        workspaceGrants: true,
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
        contextInjection: true,
        sessionResumption: false,
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
    // stay provider-managed (sandbox-bounded, not individually mediated), but
    // brokered TaskWraith MCP tools route through PermissionService /
    // requestAgenticServiceApproval, so per-provider workspace grants apply.
    return {
      provider,
      label: providerLabel(provider),
      transport: 'cursor-cli',
      runChannel: 'run-agent',
      capabilitySource: 'provider',
      features: {
        persistentSessions: false,
        appManagedApprovals: false,
        workspaceGrants: true,
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
        contextInjection: true,
        sessionResumption: false,
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
            'Cursor runs are contained by --sandbox enabled (honest partial backstop). Native tool calls are not individually mediated; brokered TaskWraith MCP tools route through TaskWraith approvals and Tool Grants.'
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
        workspaceGrants: true,
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
  if (provider === 'pi') {
    // Pi has no built-in permission system; containment is TaskWraith-owned
    // argv (tool allowlist by posture, project-config discovery disabled) plus
    // the BYOK env firewall. Native tools are not individually mediated —
    // write posture is the diff-review model, like Grok write mode.
    return {
      provider,
      label: providerLabel(provider),
      transport: 'pi-cli',
      runChannel: 'run-agent',
      capabilitySource: 'provider',
      features: {
        persistentSessions: true,
        appManagedApprovals: false,
        workspaceGrants: false,
        agentBenchMcpBridge: false,
        providerManagedMcp: false,
        nativeThreadTools: true,
        hostCommandFallback: false
      },
      capabilities: {
        approvalModes: ['plan', 'default'],
        // Pi's per-model thinking maps are sparse (many levels resolve to
        // null); v1 defers to pi's own per-model default instead of an
        // effort picker.
        reasoningEffort: false,
        speedTiers: [],
        imageAttachments: false,
        contextInjection: false,
        sessionResumption: true,
        perThreadMcp: false,
        assistantTextStreaming: 'token'
      },
      capabilityCaveats: [
        {
          id: 'pi-tool-allowlist-posture',
          severity: 'info',
          capability: 'approvalModes',
          title: 'Pi posture rides its tool allowlist',
          message:
            'Pi ships no permission prompts. Plan seats run with read-only built-ins (read, grep, find, ls); write-capable seats add bash, edit and write without per-call approval — review changes via diffs. The TaskWraith MCP bridge is not attached in this version.'
        }
      ]
    }
  }
  if (provider === 'antigravity') {
    return {
      provider,
      label: providerLabel(provider),
      transport: 'antigravity-cli',
      runChannel: 'run-agent',
      capabilitySource: 'provider',
      features: {
        persistentSessions: false,
        appManagedApprovals: false,
        // The gemini-api agentic lane executes TaskWraith MCP tools through the
        // shared executeGeminiMcpTool gateway (central approval gate), so
        // per-provider workspace grants apply here too.
        workspaceGrants: true,
        agentBenchMcpBridge: false,
        providerManagedMcp: false,
        nativeThreadTools: true,
        hostCommandFallback: false
      },
      capabilities: {
        approvalModes: ['plan', 'default'],
        reasoningEffort: true,
        speedTiers: [],
        imageAttachments: false,
        contextInjection: false,
        // `agy --print` has no supported structured conversation receipt in
        // this transport. S3 deliberately does not infer one from hooks/logs.
        sessionResumption: false,
        perThreadMcp: false,
        assistantTextStreaming: 'token'
      },
      capabilityCaveats: [
        {
          id: 'antigravity-official-cli-risk-boundary',
          severity: 'warning',
          capability: 'approvalModes',
          title: 'Official CLI only; account risk remains',
          message:
            'AntiGravity launches only the user-installed official agy CLI after recorded informed consent. TaskWraith does not access OAuth credentials or bypass permissions; this does not imply Google ToS approval or account safety.'
        }
      ]
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
      workspaceGrants: true,
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
