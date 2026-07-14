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
      async (
        _event: unknown,
        provider: ProviderId,
        workspacePath?: string,
        approvalMode?: string
      ) =>
        ({
          provider,
          workspacePath,
          approvalMode
        }) as unknown as ProviderCapabilityContract
    ),
    getProviderAdapterDescriptors: vi.fn(() => adapters),
    isMainRendererSender: vi.fn(() => true),
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
    const event = { sender: { id: 42 } }

    await expect(
      handlerFor('get-provider-capabilities')(event, 'claude', '/repo', 'workspace')
    ).resolves.toEqual({
      provider: 'claude',
      workspacePath: '/repo',
      approvalMode: 'workspace'
    })
    expect(deps.assertProviderId).toHaveBeenCalledWith('claude')
    expect(deps.getProviderCapabilityContract).toHaveBeenCalledWith(
      event,
      'claude',
      '/repo',
      'workspace'
    )

    await handlerFor('get-provider-capabilities')(event, 'claude')
    expect(deps.getProviderCapabilityContract).toHaveBeenLastCalledWith(
      event,
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

  it('projects secondary provider status without host paths, account data, or raw diagnostics', async () => {
    const contract = {
      provider: 'codex',
      label: 'Codex',
      refreshedAt: '2026-07-13T00:00:00.000Z',
      workspacePath: '/Users/private/Test 1',
      availability: {
        available: true,
        binaryPath: '/Users/private/.local/bin/codex',
        binarySource: 'path',
        version: '1.2.3',
        authState: 'authenticated',
        error: 'private diagnostic'
      },
      tools: {
        shellCommands: {
          id: 'shellCommands',
          label: 'Shell',
          state: 'available',
          source: 'taskwraith',
          requiresApproval: true,
          tools: ['run_shell_command'],
          details: 'private diagnostic'
        }
      },
      approvals: {
        requestedMode: 'default',
        effectiveMode: 'default',
        providerMode: 'default',
        inAppApprovals: true,
        supportsWorkspaceGrants: true,
        notes: ['private diagnostic']
      },
      mcp: {
        state: 'available',
        source: 'bridge',
        available: true,
        serverName: 'TaskWraith',
        tools: ['read_file'],
        message: 'socket at /private/tmp/taskwraith.sock'
      },
      warnings: [
        {
          id: 'warning-1',
          severity: 'warning',
          title: 'Provider warning',
          message: 'binary at /Users/private/.local/bin/codex'
        }
      ]
    } as unknown as ProviderCapabilityContract
    const { deps } = createDeps({
      isMainRendererSender: vi.fn(() => false),
      getAgentMcpStatusSnapshot: vi.fn(async () => ({
        provider: 'codex',
        available: true,
        command: '/Users/private/.local/bin/codex',
        data: [{ name: 'private-server', tools: [{ name: 'read_file' }] }]
      })),
      getProviderCapabilityContract: vi.fn(async () => contract)
    })
    registerProviderMetadataHandlers(deps)
    const event = { sender: { id: 42 } }

    const mcpStatus = await handlerFor('get-agent-mcp-status')(event, 'codex')
    const capabilities = await handlerFor('get-provider-capabilities')(
      event,
      'codex',
      '/Users/private/Test 1',
      'default'
    )

    expect(mcpStatus).toEqual({ provider: 'codex', available: true, serverCount: 1, toolCount: 1 })
    expect(capabilities).toMatchObject({
      provider: 'codex',
      availability: { available: true, version: '1.2.3', authState: 'authenticated' },
      tools: { shellCommands: { tools: [] } },
      approvals: { notes: [] },
      mcp: { tools: [] },
      warnings: [
        {
          id: 'warning-1',
          message: 'Open the main window for provider diagnostic details.'
        }
      ]
    })
    expect(JSON.stringify({ mcpStatus, capabilities })).not.toContain('/Users/private')
    expect(JSON.stringify({ mcpStatus, capabilities })).not.toContain('/private/tmp')
    expect(JSON.stringify({ mcpStatus, capabilities })).not.toContain('private diagnostic')
  })
})
