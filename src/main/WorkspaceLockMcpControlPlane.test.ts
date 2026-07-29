import { describe, expect, it, vi } from 'vitest'

import {
  WorkspaceLockMcpControlPlane,
  type WorkspaceLockMcpControlPlaneDependencies
} from './WorkspaceLockMcpControlPlane'
import type { WorkspaceLockMcpExecutionContext } from './WorkspaceLockMcpExecutionCoordinator'
import type { WorkspaceLockRuntime } from './WorkspaceLockRuntime'

interface TestContext extends WorkspaceLockMcpExecutionContext {
  marker: string
}

function dependencies(
  overrides: Partial<WorkspaceLockMcpControlPlaneDependencies<TestContext>> = {}
): WorkspaceLockMcpControlPlaneDependencies<TestContext> {
  return {
    getChat: () => ({ workspacePath: '/repo', title: 'Chat' }),
    validateLaneWriteScope: () => undefined,
    markLaneBlocked: vi.fn(),
    encode: (payload) => JSON.stringify(payload),
    providerDisplayName: (provider) => provider,
    externalMutationAuthority: {
      canonicalizePath: (path) => path,
      resolvePrimaryWorkspacePath: () => '/repo',
      findValidatedSignedWriteGrant: () => undefined,
      isTrustedSessionWriteAuthorized: () => false
    },
    ...overrides
  }
}

function runtime(overrides: Partial<WorkspaceLockRuntime> = {}): WorkspaceLockRuntime {
  return {
    markUnhealthy: vi.fn(),
    releaseRun: vi.fn(async () => ({
      ok: true as const,
      transitionId: 'release-1',
      released: []
    })),
    ...overrides
  } as unknown as WorkspaceLockRuntime
}

describe('WorkspaceLockMcpControlPlane', () => {
  it('installs one shared runtime and applies one fail-closed reason everywhere', () => {
    const controlPlane = new WorkspaceLockMcpControlPlane<TestContext>(dependencies())
    const installed = runtime()

    controlPlane.installRuntime(installed)
    controlPlane.poison('durable reconciliation failed')

    expect(controlPlane.getRuntime()).toBe(installed)
    expect(installed.markUnhealthy).toHaveBeenCalledWith(
      'Workspace-lock mutation admission is fail-closed: durable reconciliation failed'
    )
    expect(controlPlane.getBlockedReason()).toBe(
      'Workspace-lock mutation admission is fail-closed: durable reconciliation failed'
    )
    expect(() => controlPlane.installRuntime(runtime())).toThrow(/already installed/)
  })

  it('routes terminal lifecycle release through the installed runtime', async () => {
    const releaseRun = vi.fn(async () => ({
      ok: true as const,
      transitionId: 'release-1',
      released: []
    }))
    const controlPlane = new WorkspaceLockMcpControlPlane<TestContext>(dependencies())
    controlPlane.installRuntime(runtime({ releaseRun } as Partial<WorkspaceLockRuntime>))

    controlPlane.lifecycle.terminal('run-1')

    await vi.waitFor(() => expect(releaseRun).toHaveBeenCalledWith('run-1'))
    await vi.waitFor(() => expect(controlPlane.lifecycle.snapshot('run-1')).toBeNull())
  })

  it('projects startup recovery failure through admission without a runtime', async () => {
    const controlPlane = new WorkspaceLockMcpControlPlane<TestContext>(dependencies())
    controlPlane.blockStartup('Workspace-lock WAL recovery failed.')

    const result = await controlPlane.admission.admit({
      context: {
        scope: 'workspace',
        cwd: '/repo',
        workspacePath: '/repo',
        appRunId: 'run-1',
        appChatId: 'chat-1',
        marker: 'preserved'
      },
      provider: 'codex',
      toolName: 'write_file',
      args: { path: 'file.txt', content: 'body' }
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'Workspace-lock WAL recovery failed.'
    })
  })
})
