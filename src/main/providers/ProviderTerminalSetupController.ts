/**
 * Electron-free owner of the bounded provider-terminal setup contract.
 *
 * The injected launcher remains responsible for opening a user-visible
 * terminal. This controller only admits catalogued flows and binds the Host
 * command id to the operation identity; no credentials, commands, URLs, or
 * terminal output cross this seam.
 */

import type { ProviderId } from '../store/types'
import { buildProviderManualSetupFlow } from './ProviderManualSetupFlowCatalog'

export type ProviderTerminalSetupAction = 'login' | 'logout' | 'upgrade'

export interface ProviderTerminalSetupLaunchResult {
  readonly ok: boolean
  readonly error?: string
  readonly scope?: 'user-owned-provider-setup'
  readonly managedRunReady?: false
  readonly notice?: string
}

export interface ProviderTerminalSetupControllerOptions {
  readonly launch: (
    provider: ProviderId,
    action: ProviderTerminalSetupAction
  ) => ProviderTerminalSetupLaunchResult | Promise<ProviderTerminalSetupLaunchResult>
}

export interface ProviderTerminalSetupController {
  open(
    provider: ProviderId,
    action: ProviderTerminalSetupAction
  ): Promise<ProviderTerminalSetupLaunchResult>
  begin(input: {
    readonly provider: ProviderId
    readonly flowId: string
    readonly operationId: string
  }): Promise<{ readonly provider: ProviderId; readonly operationId: string }>
  cancel(input: {
    readonly provider: ProviderId
    readonly operationId: string
  }): Promise<{ readonly outcome: 'not_cancellable' }>
}

export function createProviderTerminalSetupController(
  options: ProviderTerminalSetupControllerOptions
): ProviderTerminalSetupController {
  if (!options || typeof options.launch !== 'function') {
    throw new Error('ProviderTerminalSetupController requires an injected launch port')
  }
  const open = async (provider: ProviderId, action: ProviderTerminalSetupAction) => {
    // IPC remains a compatibility surface (including its legacy explanatory
    // errors). Host `begin` below is the narrowed catalogue-gated path.
    const result = await options.launch(provider, action)
    return result && typeof result.ok === 'boolean'
      ? result
      : { ok: false, error: 'Provider setup terminal is unavailable' }
  }
  return {
    open,
    async begin(input) {
      if (
        !input ||
        typeof input.operationId !== 'string' ||
        input.operationId.length === 0 ||
        input.flowId !== `${input.provider}:login` ||
        !buildProviderManualSetupFlow(input.provider, 'login')
      ) {
        throw new Error('Provider login flow is unavailable')
      }
      const result = await open(input.provider, 'login')
      if (!result.ok) throw new Error('Provider login terminal could not be started')
      return { provider: input.provider, operationId: input.operationId }
    },
    async cancel() {
      // A detached interactive terminal cannot be safely terminated by a Host
      // command after launch. Never claim cancellation we cannot prove.
      return { outcome: 'not_cancellable' }
    }
  }
}
