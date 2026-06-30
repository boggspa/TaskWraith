import { ipcMain } from 'electron'
import type {
  ProviderAdapterDescriptor,
  ProviderCapabilityContract,
  ProviderId
} from '../store/types'

export interface ProviderMetadataHandlersDeps {
  assertProviderId: (provider: unknown) => ProviderId
  getAgentMcpStatusSnapshot: (provider: ProviderId) => Promise<unknown>
  getProviderCapabilityContract: (
    provider: ProviderId,
    workspacePath?: string,
    approvalMode?: string
  ) => Promise<ProviderCapabilityContract>
  getProviderAdapterDescriptors: () => ProviderAdapterDescriptor[]
}

export function registerProviderMetadataHandlers(deps: ProviderMetadataHandlersDeps): void {
  ipcMain.handle('get-agent-mcp-status', async (_, provider: ProviderId) => {
    return deps.getAgentMcpStatusSnapshot(deps.assertProviderId(provider))
  })

  ipcMain.handle(
    'get-provider-capabilities',
    async (_, provider: ProviderId, workspacePath?: string, approvalMode?: string) => {
      return deps.getProviderCapabilityContract(
        deps.assertProviderId(provider),
        workspacePath,
        approvalMode
      )
    }
  )

  ipcMain.handle('get-provider-adapters', () => deps.getProviderAdapterDescriptors())
}
