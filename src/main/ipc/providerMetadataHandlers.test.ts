import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type {
  ProviderAdapterDescriptor,
  ProviderCapabilityContract,
  ProviderId
} from '../store/types'
import {
  registerProviderMetadataHandlers,
  type ProviderMetadataHandlersDeps
} from './providerMetadataHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps(overrides: Partial<ProviderMetadataHandlersDeps> = {}) {
  const adapters = [{ provider: 'codex' }] as unknown as ProviderAdapterDescriptor[]
  const deps: ProviderMetadataHandlersDeps = {
    assertProviderId: vi.fn((provider: unknown) => String(provider).trim() as ProviderId),
    getAgentMcpStatusSnapshot: vi.fn(async (provider: ProviderId) => ({
      provider,
      status: 'ok'
    })),
    getProviderCapabilityContract: vi.fn(
      async (provider: ProviderId, workspacePath?: string, approvalMode?: string) =>
        ({
          provider,
          workspacePath,
          approvalMode
        }) as unknown as ProviderCapabilityContract
    ),
    getProviderAdapterDescriptors: vi.fn(() => adapters),
    ...overrides
  }
  return {
    deps,
    adapters
  }
}

describe('registerProviderMetadataHandlers', () => {
  it('registers provider metadata IPC channels', () => {
    registerProviderMetadataHandlers(createDeps().deps)

    expect(handlerFor('get-agent-mcp-status')).toBeTypeOf('function')
    expect(handlerFor('get-provider-capabilities')).toBeTypeOf('function')
    expect(handlerFor('get-provider-adapters')).toBeTypeOf('function')
  })

  it('validates provider before reading MCP status', async () => {
    const { deps } = createDeps()
    registerProviderMetadataHandlers(deps)

    await expect(handlerFor('get-agent-mcp-status')({}, 'codex')).resolves.toEqual({
      provider: 'codex',
      status: 'ok'
    })
    expect(deps.assertProviderId).toHaveBeenCalledWith('codex')
    expect(deps.getAgentMcpStatusSnapshot).toHaveBeenCalledWith('codex')
  })

  it('validates provider and forwards optional capability args unchanged', async () => {
    const { deps } = createDeps()
    registerProviderMetadataHandlers(deps)

    await expect(
      handlerFor('get-provider-capabilities')({}, 'claude', '/repo', 'workspace')
    ).resolves.toEqual({
      provider: 'claude',
      workspacePath: '/repo',
      approvalMode: 'workspace'
    })
    expect(deps.assertProviderId).toHaveBeenCalledWith('claude')
    expect(deps.getProviderCapabilityContract).toHaveBeenCalledWith(
      'claude',
      '/repo',
      'workspace'
    )

    await handlerFor('get-provider-capabilities')({}, 'claude')
    expect(deps.getProviderCapabilityContract).toHaveBeenLastCalledWith(
      'claude',
      undefined,
      undefined
    )
  })

  it('does not delegate when provider validation fails', async () => {
    const error = new Error('Invalid provider')
    const { deps } = createDeps({
      assertProviderId: vi.fn(() => {
        throw error
      })
    })
    registerProviderMetadataHandlers(deps)

    await expect(handlerFor('get-agent-mcp-status')({}, 'invalid-provider')).rejects.toThrow(
      error
    )
    expect(deps.getAgentMcpStatusSnapshot).not.toHaveBeenCalled()

    await expect(
      handlerFor('get-provider-capabilities')({}, 'invalid-provider', '/repo', 'workspace')
    ).rejects.toThrow(error)
    expect(deps.getProviderCapabilityContract).not.toHaveBeenCalled()
  })

  it('returns provider adapter descriptors without args', () => {
    const { deps, adapters } = createDeps()
    registerProviderMetadataHandlers(deps)

    expect(handlerFor('get-provider-adapters')({})).toBe(adapters)
    expect(deps.getProviderAdapterDescriptors).toHaveBeenCalledOnce()
  })
})
