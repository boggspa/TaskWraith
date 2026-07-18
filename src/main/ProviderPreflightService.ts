import { evaluateOllamaModelPreflight } from './ollama/OllamaModelPreflight'
import type { OllamaModelInfo } from './ollama/OllamaProvider'
import type {
  ProviderAdapterDescriptor,
  ProviderCapabilityContract,
  ProviderCapabilityWarning,
  ProviderId
} from './store/types'
import { toolingControlRows } from './ProviderCapabilities'
import { isRetiredProvider } from '../shared/retiredProviders'
import { codexModelRetiresAt, isCodexModelRetired } from '../shared/codexModelLifecycle'
import {
  isPreviewModelPlaceholder,
  isPreviewRiskModel,
  previewModelAccessReason
} from '../shared/previewModelCatalog'

export type ProviderPreflightState = 'ready' | 'repairable' | 'blocked'
export type ProviderPreflightRepairAction =
  | 'install_gemini_bridge'
  | 'configure_provider'
  | 'login_provider'
  | 'none'

export interface ProviderPreflightInput {
  provider: ProviderId
  workspacePath?: string
  approvalMode?: string
  model?: string | null
  previewModelAccessProven?: boolean
  /** Ollama /api/tags metadata for the requested model (when known). */
  ollamaModelInfo?: OllamaModelInfo | null
  ollamaInstalledModelIds?: string[]
  totalMemoryBytes?: number
}

export interface ProviderPreflightResult {
  provider: ProviderId
  state: ProviderPreflightState
  reason: string
  repairAction: ProviderPreflightRepairAction
  fallbackAvailable: boolean
  contract: ProviderCapabilityContract
  chips: ProviderCapabilityWarning[]
}

function warning(
  id: string,
  severity: ProviderCapabilityWarning['severity'],
  title: string,
  message: string
): ProviderCapabilityWarning {
  return { id, severity, title, message }
}

function providerSetupRepairAction(
  contract: ProviderCapabilityContract
): ProviderPreflightRepairAction {
  const authState = contract.availability.authState || ''
  if (/missing|expired|login|required/i.test(authState)) return 'login_provider'
  return 'configure_provider'
}

export class ProviderPreflightService {
  evaluate(
    input: ProviderPreflightInput,
    contract: ProviderCapabilityContract,
    descriptor?: ProviderAdapterDescriptor
  ): ProviderPreflightResult {
    const chips: ProviderCapabilityWarning[] = [...contract.warnings]
    const label = contract.label || input.provider

    if (isRetiredProvider(input.provider)) {
      const reason = `${label} has been retired. Chat history is preserved; start a new chat with another provider to continue.`
      return {
        provider: input.provider,
        state: 'blocked',
        reason,
        repairAction: 'none',
        fallbackAvailable: false,
        contract,
        chips: [warning(`${input.provider}-retired`, 'error', `${label} retired`, reason), ...chips]
      }
    }

    const requestedModel = input.model?.trim()
    if (input.provider === 'codex' && requestedModel && isCodexModelRetired(requestedModel)) {
      const retiredAt = codexModelRetiresAt(requestedModel)
      const reason = retiredAt
        ? `${requestedModel} was retired on ${retiredAt}. Choose an active Codex model to continue.`
        : `${requestedModel} has been retired. Choose an active Codex model to continue.`
      return {
        provider: input.provider,
        state: 'blocked',
        reason,
        repairAction: 'none',
        fallbackAvailable: false,
        contract,
        chips: [warning('codex-model-retired', 'error', 'Codex model retired', reason), ...chips]
      }
    }

    if (!contract.availability.available) {
      const reason =
        contract.availability.error ||
        `${label} is not ready. Check provider setup before starting a run.`
      return {
        provider: input.provider,
        state: 'blocked',
        reason,
        repairAction: providerSetupRepairAction(contract),
        fallbackAvailable: Boolean(descriptor?.features.hostCommandFallback),
        contract,
        chips: [
          warning(`${input.provider}-preflight-blocked`, 'error', `${label} blocked`, reason),
          ...chips
        ]
      }
    }

    if (
      input.model &&
      (isPreviewModelPlaceholder(input.model) ||
        (isPreviewRiskModel(input.provider, input.model) && !input.previewModelAccessProven))
    ) {
      const reason = previewModelAccessReason(input.provider)
      return {
        provider: input.provider,
        state: 'blocked',
        reason,
        repairAction: 'none',
        fallbackAvailable: false,
        contract,
        chips: [
          warning(
            `${input.provider}-preview-model-access`,
            'warning',
            'Preview model unavailable',
            reason
          ),
          ...chips
        ]
      }
    }

    if (
      input.provider === 'gemini' &&
      contract.mcp.enabled &&
      (!contract.mcp.installed || !contract.mcp.available)
    ) {
      const reason =
        contract.mcp.message ||
        (contract.mcp.installed
          ? 'TaskWraith MCP bridge is installed but unavailable.'
          : 'TaskWraith MCP bridge is not installed.')
      return {
        provider: input.provider,
        state: 'blocked',
        reason,
        repairAction: 'install_gemini_bridge',
        fallbackAvailable: false,
        contract,
        chips: [
          warning('gemini-mcp-bridge-blocked', 'error', 'Gemini bridge blocked', reason),
          ...chips
        ]
      }
    }

    // Tally over the five functional-control rows only. The DISPLAY-only
    // elicit/delegate rows are intentionally excluded so promoting
    // subThreadDelegation to a row never inflates this count.
    const controlRows = toolingControlRows(contract.tools)
    const delegatedTools = controlRows.filter((tool) => !tool.enforcedByTaskWraith)
    if (delegatedTools.length > 0) {
      chips.unshift(
        warning(
          `${input.provider}-delegated-enforcement`,
          'info',
          'Provider-managed controls',
          `${delegatedTools.length}/${controlRows.length} tooling controls are delegated or best-effort for ${label}.`
        )
      )
    }

    if (input.provider === 'ollama' && input.model?.trim()) {
      const modelId = input.model.trim()
      const modelLabel = input.ollamaModelInfo?.label || modelId
      const ollamaPreflight = evaluateOllamaModelPreflight({
        modelId,
        modelLabel,
        modelInfo: input.ollamaModelInfo,
        installedModelIds: input.ollamaInstalledModelIds || [],
        totalMemoryBytes: input.totalMemoryBytes || 16 * 1024 ** 3
      })
      for (const item of ollamaPreflight.warnings) {
        if (chips.some((chip) => chip.id === item.id)) continue
        chips.unshift(item)
      }
    }

    return {
      provider: input.provider,
      state: 'ready',
      reason: `${label} is ready.`,
      repairAction: 'none',
      fallbackAvailable: Boolean(descriptor?.features.hostCommandFallback),
      contract,
      chips
    }
  }
}
