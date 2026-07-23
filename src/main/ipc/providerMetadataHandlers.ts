import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  ProviderAdapterDescriptor,
  ProviderCapabilityContract,
  ProviderId
} from '../store/types'
import {
  rendererSafeProviderCapabilityContract,
  rendererSafeProviderMcpStatus
} from '../RendererProviderProjection'

export interface ProviderMetadataHandlersDeps {
  assertProviderId: (provider: unknown) => ProviderId
  getAgentMcpStatusSnapshot: (provider: ProviderId) => Promise<unknown>
  getProviderCapabilityContract: (
    event: IpcMainInvokeEvent,
    provider: ProviderId,
    workspacePath?: string,
    approvalMode?: string
  ) => Promise<ProviderCapabilityContract>
  getProviderAdapterDescriptors: () => ProviderAdapterDescriptor[]
  getConfiguredProviderSnapshot: () => {
    ready: boolean
    providerIds: ProviderId[]
    modelsByProvider?: Partial<Record<ProviderId, Array<{ id: string; label: string }>>>
  }
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerProviderMetadataHandlers(deps: ProviderMetadataHandlersDeps): void {
  ipcMain.handle('get-agent-mcp-status', async (event, provider: ProviderId) => {
    const status = await deps.getAgentMcpStatusSnapshot(deps.assertProviderId(provider))
    return deps.isMainRendererSender(event) ? status : rendererSafeProviderMcpStatus(status)
  })

  ipcMain.handle(
    'get-provider-capabilities',
    async (event, provider: ProviderId, workspacePath?: string, approvalMode?: string) => {
      const contract = await deps.getProviderCapabilityContract(
        event,
        deps.assertProviderId(provider),
        workspacePath,
        approvalMode
      )
      return deps.isMainRendererSender(event)
        ? contract
        : rendererSafeProviderCapabilityContract(contract)
    }
  )

  ipcMain.handle('get-provider-adapters', () => deps.getProviderAdapterDescriptors())
  ipcMain.handle('get-configured-provider-snapshot', () => deps.getConfiguredProviderSnapshot())
}
