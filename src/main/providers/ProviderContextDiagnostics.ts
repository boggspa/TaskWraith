import { knownModelContextWindow } from '../../shared/contextWindows'
import {
  providerRuntimeVersion,
  type ProviderContextPolicy
} from '../../shared/providerContextPolicy'
import type { ContextCompactionSignal } from '../../shared/contextCompaction'
import { codexModelContextConfig } from './StaticProviderModels'
import type { ClaudeContextPreference } from './ClaudeContextPreference'

export interface ContextDiagnosticOwner {
  appRunId?: string
  appChatId?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function positiveTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Each state object owns its receipts; simultaneous seats never share a snapshot. */
export class ProviderContextDiagnostics {
  private readonly policies = new WeakMap<ContextDiagnosticOwner, ProviderContextPolicy>()

  constructor(
    private readonly onChange: (
      owner: ContextDiagnosticOwner,
      policy: ProviderContextPolicy
    ) => void,
    private readonly canPublish: (
      owner: ContextDiagnosticOwner,
      provider: 'claude' | 'codex'
    ) => boolean = () => true
  ) {}

  configureCodex(
    owner: ContextDiagnosticOwner,
    model: string,
    runtimeVersion?: string,
    requestedConfig: Readonly<Record<string, unknown>> = { ...codexModelContextConfig(model) }
  ): void {
    const requestedWindowTokens = positiveTokens(requestedConfig?.model_context_window)
    const requestedCompactionTokens = positiveTokens(
      requestedConfig?.model_auto_compact_token_limit
    )
    this.publish(owner, {
      provider: 'codex',
      model,
      modelCapacityTokens: knownModelContextWindow(model),
      requestedWindowTokens,
      requestedCompactionTokens,
      configurationSource:
        requestedWindowTokens || requestedCompactionTokens ? 'taskwraith' : 'provider-default',
      runtimeVersion: providerRuntimeVersion(runtimeVersion)
    })
  }

  configureClaude(
    owner: ContextDiagnosticOwner,
    model: string,
    preference?: ClaudeContextPreference
  ): void {
    this.publish(owner, {
      provider: 'claude',
      model,
      modelCapacityTokens: knownModelContextWindow(model),
      requestedCompactionTokens: preference?.windowTokens,
      configurationSource: preference?.source || 'provider-default'
    })
  }

  observeCodex(owner: ContextDiagnosticOwner, tokenUsage: unknown): void {
    const policy = this.policies.get(owner)
    const reportedWindowTokens = positiveTokens(record(tokenUsage).modelContextWindow)
    if (!policy || policy.provider !== 'codex' || reportedWindowTokens === undefined) return
    this.publish(owner, { ...policy, reportedWindowTokens })
  }

  observeClaude(owner: ContextDiagnosticOwner, event: unknown): void {
    const policy = this.policies.get(owner)
    if (!policy || policy.provider !== 'claude') return
    const frame = record(event)
    if (frame.type === 'system' && frame.subtype === 'init') {
      const model = typeof frame.model === 'string' && frame.model ? frame.model : policy.model
      this.publish(owner, {
        ...policy,
        model,
        modelCapacityTokens: knownModelContextWindow(model),
        runtimeVersion: providerRuntimeVersion(frame.claude_code_version) || policy.runtimeVersion
      })
    } else if (frame.type === 'result') {
      const usage = record(record(frame.modelUsage)[policy.model])
      const reportedWindowTokens = positiveTokens(usage.contextWindow)
      if (reportedWindowTokens !== undefined)
        this.publish(owner, { ...policy, reportedWindowTokens })
    }
  }

  enrich(owner: ContextDiagnosticOwner, signal: ContextCompactionSignal): ContextCompactionSignal {
    const policy = this.policies.get(owner)
    return policy
      ? { ...signal, telemetry: { ...signal.telemetry, contextPolicy: { ...policy } } }
      : signal
  }

  private publish(owner: ContextDiagnosticOwner, policy: ProviderContextPolicy): void {
    if (JSON.stringify(this.policies.get(owner)) === JSON.stringify(policy)) return
    this.policies.set(owner, Object.freeze({ ...policy }))
    try {
      if (this.canPublish(owner, policy.provider)) this.onChange(owner, { ...policy })
    } catch {
      // Diagnostic persistence never changes provider execution or permissions.
    }
  }
}
