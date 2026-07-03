import { describe, expect, it, vi } from 'vitest'
import {
  ApprovalService,
  type ApprovalServiceDeps,
  type PendingMainApproval,
  type PendingGeminiToolApproval,
  type PendingCodexApproval,
  type PendingHostCommandApproval
} from './ApprovalService'
import {
  ApprovalTimeoutScheduler,
  DEFAULT_APPROVAL_TIMEOUT_POLICY
} from '../ApprovalTimeoutScheduler'
import type { BridgeRemoteAttentionPushPayload } from '../BridgeApnsPusher'

type AttentionPushCall = [string, 'production' | 'sandbox', BridgeRemoteAttentionPushPayload]

/**
 * Phase B3 — unit tests for ApprovalService.
 *
 * The service has a big surface (5 registries + scheduling + APNs
 * wake-push + dispatch) so the tests focus on:
 *   - Register / has / lookup behaviour
 *   - resolve() dispatches to the right provider-specific completion
 *     for each registry, walking them in the documented order
 *   - resolve() returns false when no registry holds the id
 *   - Auto-deny path (decisionSource: 'system') threads through
 *   - Wake-push is suppressed when the user is at the desktop
 *   - Wake-push prunes dead tokens on Apple rejection
 *
 * The scheduler is mocked — its own unit tests (covered separately in
 * `ApprovalTimeoutScheduler.test.ts`) handle the timer behaviour.
 */

function makeDeps(overrides: Partial<ApprovalServiceDeps> = {}): {
  deps: ApprovalServiceDeps
  spies: {
    runManager: {
      get: ReturnType<typeof vi.fn>
      resolveApproval: ReturnType<typeof vi.fn>
      clearApproval: ReturnType<typeof vi.fn>
    }
    permissionService: {
      applyApprovalDecision: ReturnType<typeof vi.fn>
      isApprovedAction: ReturnType<typeof vi.fn>
    }
    appendDurableRunEventForRoute: ReturnType<typeof vi.fn>
    resolveApprovalLedger: ReturnType<typeof vi.fn>
    codexClient: {
      respond: ReturnType<typeof vi.fn>
      reject: ReturnType<typeof vi.fn>
    }
    sendAgentCompatLine: ReturnType<typeof vi.fn>
    respondToKimiWireRequest: ReturnType<typeof vi.fn>
    runApprovedHostCommand: ReturnType<typeof vi.fn>
    isUserAtDesktop: ReturnType<typeof vi.fn>
    workspaceIdForPath: ReturnType<typeof vi.fn>
    publishApprovalRunEvent: ReturnType<typeof vi.fn>
    getApprovalTimeoutSettings: ReturnType<typeof vi.fn>
    log: ReturnType<typeof vi.fn>
  }
} {
  const codexClient = {
    respond: vi.fn(),
    reject: vi.fn()
  }
  const spies = {
    runManager: {
      get: vi.fn(() => ({ runId: 'r-1', appChatId: 'c-1', providerSessionId: 's-1' })),
      resolveApproval: vi.fn(() => ({ runId: 'r-1', appChatId: 'c-1' })),
      clearApproval: vi.fn()
    },
    permissionService: {
      applyApprovalDecision: vi.fn((input: { action: string }) =>
        [
          'accept',
          'acceptForSession',
          'acceptForWorkspace',
          'grantExternalPathRead',
          'grantExternalPathEdit'
        ].includes(input.action)
      ),
      isApprovedAction: vi.fn(
        (action: string) => action === 'accept' || action === 'acceptForSession'
      )
    },
    appendDurableRunEventForRoute: vi.fn(),
    resolveApprovalLedger: vi.fn(),
    codexClient,
    sendAgentCompatLine: vi.fn(),
    respondToKimiWireRequest: vi.fn(),
    runApprovedHostCommand: vi.fn(async () => true),
    isUserAtDesktop: vi.fn(() => false),
    workspaceIdForPath: vi.fn((p?: string) => p ?? 'global'),
    publishApprovalRunEvent: vi.fn(),
    getApprovalTimeoutSettings: vi.fn(() => ({
      enabled: true,
      perProviderMs: {
        gemini: 120_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000,
        grok: 75_000,
        cursor: 80_000,
        ollama: 85_000
      },
      mainAuthorityMs: 60_000
    })),
    log: vi.fn()
  }
  return {
    spies,
    deps: {
      runManager: spies.runManager as never,
      permissionService: spies.permissionService as never,
      appendDurableRunEventForRoute: spies.appendDurableRunEventForRoute as never,
      resolveApprovalLedger: spies.resolveApprovalLedger,
      getCodexClient: () => codexClient,
      sendAgentCompatLine: spies.sendAgentCompatLine,
      respondToKimiWireRequest: spies.respondToKimiWireRequest as never,
      runApprovedHostCommand: spies.runApprovedHostCommand,
      cliProviderProcesses: new Map(),
      getApnsPusher: () => null,
      getApnsTokenStore: () => null,
      isUserAtDesktop: spies.isUserAtDesktop,
      workspaceIdForPath: spies.workspaceIdForPath,
      publishApprovalRunEvent: spies.publishApprovalRunEvent,
      getApprovalTimeoutSettings: spies.getApprovalTimeoutSettings,
      log: spies.log,
      ...overrides
    }
  }
}

describe('ApprovalService — registries', () => {
  it('has() returns false on a fresh service', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    expect(svc.has('any-id')).toBe(false)
  })

  it('registerMain → has() returns true and publishes approval_pending', () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    const resolveFn = vi.fn()
    svc.registerMain('m-1', {
      provider: 'gemini',
      workspacePath: '/ws',
      runId: 'r-1',
      resolve: resolveFn
    })
    expect(svc.has('m-1')).toBe(true)
    expect(spies.publishApprovalRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approval_pending',
        approvalId: 'm-1',
        provider: 'gemini',
        workspaceId: '/ws',
        appRunId: 'r-1',
        appChatId: 'c-1',
        threadId: 'c-1'
      })
    )
  })

  it('pendingCounts() reflects all 5 registries', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerMain('a', { provider: 'gemini', resolve: vi.fn() })
    svc.registerGeminiTool('b', { provider: 'gemini', service: 'shellCommands', resolve: vi.fn() })
    svc.registerCodex('c', { rpcId: 1, method: 'item/permissions/requestApproval', params: {} })
    svc.registerKimi('d', { child: { kill: vi.fn() } as never, rpcId: 1, params: {} })
    svc.registerHostCommand('e', {
      sender: {} as never,
      provider: 'codex',
      command: 'ls',
      commandText: 'ls',
      cwd: '/tmp',
      threadId: 't-1',
      model: 'm-1',
      reason: 'sandbox failure',
      output: 'permission denied'
    })
    expect(svc.pendingCounts()).toEqual({
      main: 1,
      geminiTool: 1,
      codex: 1,
      kimi: 1,
      hostCommand: 1
    })
  })

  it('listProjectionCards exposes pending approvals for remote task snapshots', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerCodex('c-1', {
      rpcId: 1,
      method: 'item/permissions/requestApproval',
      params: { command: 'npm test' },
      workspacePath: '/ws',
      runId: 'r-1'
    })
    svc.registerHostCommand('h-1', {
      sender: {} as never,
      provider: 'codex',
      command: 'ls',
      commandText: 'ls -la',
      cwd: '/ws',
      workspacePath: '/ws',
      threadId: 't-host',
      appChatId: 'chat-host',
      appRunId: 'run-host',
      model: 'm-1',
      reason: 'sandbox failure',
      output: 'permission denied'
    })

    expect(svc.listProjectionCards()).toEqual([
      expect.objectContaining({
        toolCallId: 'c-1',
        threadId: 'c-1',
        workspaceId: '/ws',
        runId: 'r-1',
        provider: 'codex',
        title: 'item/permissions/requestApproval'
      }),
      expect.objectContaining({
        toolCallId: 'h-1',
        threadId: 'chat-host',
        workspaceId: '/ws',
        runId: 'run-host',
        provider: 'codex',
        title: 'Run host command'
      })
    ])
  })

  it('listProjectionCards projects non-default allowed actions', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerMain('m-1', {
      provider: 'claude',
      workspacePath: '/ws',
      runId: 'r-1',
      allowedActions: ['useProviderNative', 'useTaskWraithSubthread'],
      resolve: vi.fn()
    })
    svc.registerGeminiTool('g-1', {
      provider: 'ollama',
      service: 'shellCommands',
      workspacePath: '/ws',
      runId: 'r-1',
      allowedActions: ['accept', 'decline', 'cancel'],
      resolve: vi.fn()
    })

    expect(svc.listProjectionCards()).toEqual([
      expect.objectContaining({
        toolCallId: 'm-1',
        actions: ['useProviderNative', 'useTaskWraithSubthread']
      }),
      expect.objectContaining({
        toolCallId: 'g-1',
        actions: ['accept', 'decline', 'cancel']
      })
    ])
  })

  it('listProjectionCards projects Kimi workspace from the pending record', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerKimi('k-1', {
      child: { kill: vi.fn() } as never,
      rpcId: 1,
      params: {},
      workspacePath: '/kimi-ws',
      runId: 'r-1'
    })

    expect(svc.listProjectionCards()[0]).toEqual(
      expect.objectContaining({
        toolCallId: 'k-1',
        provider: 'kimi',
        workspaceId: '/kimi-ws',
        workspacePath: '/kimi-ws'
      })
    )
  })

  it('listProjectionCards falls back to the run session workspace path', () => {
    const { deps, spies } = makeDeps()
    spies.runManager.get.mockReturnValue({
      runId: 'r-1',
      appChatId: 'c-1',
      providerSessionId: 's-1',
      workspacePath: '/session-ws'
    })
    const svc = new ApprovalService(deps)
    svc.registerKimi('k-1', {
      child: { kill: vi.fn() } as never,
      rpcId: 1,
      params: {},
      runId: 'r-1'
    })

    expect(svc.listProjectionCards()[0]).toEqual(
      expect.objectContaining({
        toolCallId: 'k-1',
        workspaceId: '/session-ws',
        workspacePath: '/session-ws'
      })
    )
  })

  it('getHostCommand returns the registered approval; deleteHostCommand removes it', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    const approval: PendingHostCommandApproval = {
      sender: {} as never,
      provider: 'codex',
      command: 'ls',
      commandText: 'ls -la',
      cwd: '/tmp',
      threadId: 't-1',
      model: 'm-1',
      reason: 'sandbox',
      output: 'denied'
    }
    svc.registerHostCommand('h-1', approval)
    expect(svc.getHostCommand('h-1')).toBe(approval)
    svc.deleteHostCommand('h-1')
    expect(svc.getHostCommand('h-1')).toBeUndefined()
  })

  it('getPendingExternalPathDetection reads provider approval registries', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    const claudeDetection = {
      provider: 'claude' as const,
      path: '/outside/file.ts',
      access: 'write' as const,
      basename: 'file.ts',
      appChatId: 'chat-1'
    }
    const kimiDetection = {
      provider: 'kimi' as const,
      path: '/outside/readme.md',
      access: 'read' as const,
      basename: 'readme.md',
      appChatId: 'chat-2'
    }
    svc.registerGeminiTool('g-1', {
      provider: 'claude',
      service: 'fileChanges',
      resolve: vi.fn(),
      externalPathDetection: claudeDetection
    })
    svc.registerKimi('k-1', {
      child: { kill: vi.fn() } as never,
      rpcId: 1,
      params: {},
      externalPathDetection: kimiDetection
    })

    expect(svc.getPendingExternalPathDetection('g-1')).toBe(claudeDetection)
    expect(svc.getPendingExternalPathDetection('k-1')).toBe(kimiDetection)
    expect(svc.getPendingExternalPathDetection('missing')).toBeUndefined()
  })
})

describe('ApprovalService — lookupRoute', () => {
  it('returns null for an unknown approvalId', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    expect(svc.lookupRoute('does-not-exist')).toBeNull()
  })

  it('returns the route for a registered Main approval', () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    spies.runManager.get.mockReturnValue({ runId: 'r-99', appChatId: 'c-99' })
    svc.registerMain('m-1', { provider: 'gemini', runId: 'r-99', resolve: vi.fn() })
    const route = svc.lookupRoute('m-1')
    expect(route).toEqual({ provider: 'gemini', appRunId: 'r-99', appChatId: 'c-99' })
  })

  it('returns the route for a registered HostCommand approval (uses its own ids)', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerHostCommand('h-1', {
      sender: {} as never,
      provider: 'codex',
      command: 'ls',
      commandText: 'ls',
      cwd: '/tmp',
      threadId: 't-1',
      model: 'm-1',
      appRunId: 'r-77',
      appChatId: 'c-77',
      reason: 'sandbox',
      output: 'denied'
    })
    const route = svc.lookupRoute('h-1')
    expect(route).toEqual({ provider: 'codex', appRunId: 'r-77', appChatId: 'c-77' })
  })
})

describe('ApprovalService — scheduleTimeout', () => {
  it('uses configured timeout windows for Grok, Cursor, and Ollama approvals', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    const scheduledMs: number[] = []
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, vi.fn(), {
      setTimeoutFn: ((_cb, ms) => {
        scheduledMs.push(ms)
        return { __timeout: scheduledMs.length } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
      clearTimeoutFn: vi.fn()
    })
    svc.setScheduler(scheduler)

    svc.scheduleTimeout({ approvalId: 'grok-approval', provider: 'grok' })
    svc.scheduleTimeout({ approvalId: 'cursor-approval', provider: 'cursor' })
    svc.scheduleTimeout({ approvalId: 'ollama-approval', provider: 'ollama' })

    expect(scheduledMs).toEqual([75_000, 80_000, 85_000])
  })
})

describe('ApprovalService — resolve dispatch', () => {
  it('returns false when no registry holds the id', async () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    const ok = await svc.resolve('phantom', 'accept')
    expect(ok).toBe(false)
  })

  it('Main: writes durable event, resolves promise with permission decision', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    const resolveFn = vi.fn()
    const approval: PendingMainApproval = {
      provider: 'gemini',
      workspacePath: '/ws',
      runId: 'r-1',
      resolve: resolveFn
    }
    svc.registerMain('m-1', approval)
    const ok = await svc.resolve('m-1', 'accept')
    expect(ok).toBe(true)
    expect(spies.appendDurableRunEventForRoute).toHaveBeenCalledWith(
      'gemini',
      expect.any(Object),
      'approval_response',
      'control',
      expect.stringContaining('Main approval response: accept'),
      expect.objectContaining({ requestId: 'm-1', action: 'accept' })
    )
    expect(spies.resolveApprovalLedger).toHaveBeenCalledWith('m-1', 'accept', 'user', {})
    expect(resolveFn).toHaveBeenCalledWith(true)
    expect(svc.has('m-1')).toBe(false)
  })

  it('Main: provider-native sub-agent action resolves true without widening generic approvals', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    const resolveFn = vi.fn()
    const resolveAction = vi.fn()
    svc.registerMain('native-1', {
      provider: 'claude',
      runId: 'r-1',
      resolve: resolveFn,
      resolveAction
    })

    const ok = await svc.resolve('native-1', 'useProviderNative')

    expect(ok).toBe(true)
    expect(resolveAction).toHaveBeenCalledWith('useProviderNative')
    expect(spies.permissionService.isApprovedAction).not.toHaveBeenCalledWith('useProviderNative')
    expect(resolveFn).toHaveBeenCalledWith(true)
  })

  it('Main: TaskWraith sub-thread action resolves false so provider-native tool is denied', async () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    const resolveFn = vi.fn()
    svc.registerMain('native-2', {
      provider: 'claude',
      runId: 'r-1',
      resolve: resolveFn
    })

    await svc.resolve('native-2', 'useTaskWraithSubthread')

    expect(resolveFn).toHaveBeenCalledWith(false)
  })

  it('GeminiTool: applies permission decision + resolves with allowed flag', async () => {
    const { deps, spies } = makeDeps()
    spies.permissionService.applyApprovalDecision.mockReturnValue(false)
    const svc = new ApprovalService(deps)
    const resolveFn = vi.fn()
    const approval: PendingGeminiToolApproval = {
      provider: 'gemini',
      service: 'shellCommands',
      workspacePath: '/ws',
      runId: 'r-1',
      resolve: resolveFn
    }
    svc.registerGeminiTool('g-1', approval)
    await svc.resolve('g-1', 'decline')
    expect(resolveFn).toHaveBeenCalledWith(false)
    expect(spies.permissionService.applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini',
        service: 'shellCommands',
        action: 'decline'
      })
    )
  })

  it('GeminiTool request-only approvals coerce grant actions to one-shot accept', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    const resolveFn = vi.fn()
    const approval: PendingGeminiToolApproval = {
      provider: 'ollama',
      service: 'shellCommands',
      workspacePath: '/ws',
      runId: 'r-1',
      requestOnly: true,
      resolve: resolveFn
    }
    svc.registerGeminiTool('g-request-only', approval)
    await svc.resolve('g-request-only', 'acceptForWorkspace')

    expect(spies.permissionService.applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ollama',
        service: 'shellCommands',
        action: 'accept'
      })
    )
    expect(spies.resolveApprovalLedger).toHaveBeenCalledWith(
      'g-request-only',
      'accept',
      'user',
      expect.objectContaining({
        requestedAction: 'acceptForWorkspace',
        requestOnly: true
      })
    )
    expect(resolveFn).toHaveBeenCalledWith(true)
  })

  it('rejects renderer-submitted actions that were not offered for the approval', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    const resolveFn = vi.fn()
    svc.registerGeminiTool('g-request-only', {
      provider: 'codex',
      service: 'shellCommands',
      workspacePath: '/ws',
      runId: 'r-1',
      requestOnly: true,
      allowedActions: ['accept', 'decline', 'cancel'],
      resolve: resolveFn
    })

    const ok = await svc.resolve('g-request-only', 'acceptForWorkspace')

    expect(ok).toBe(false)
    expect(resolveFn).not.toHaveBeenCalled()
    expect(spies.permissionService.applyApprovalDecision).not.toHaveBeenCalled()
    expect(spies.resolveApprovalLedger).not.toHaveBeenCalled()
    expect(svc.has('g-request-only')).toBe(true)
    expect(spies.log).toHaveBeenCalledWith(expect.stringContaining('rejected invalid approval action'))
  })

  it('HostCommand accept: invokes runApprovedHostCommand and does NOT clear the registry', async () => {
    const { deps, spies } = makeDeps()
    spies.runApprovedHostCommand.mockResolvedValue(true)
    const svc = new ApprovalService(deps)
    svc.registerHostCommand('h-1', {
      sender: {} as never,
      provider: 'codex',
      command: 'ls',
      commandText: 'ls',
      cwd: '/tmp',
      threadId: 't-1',
      model: 'm-1',
      reason: 'sandbox',
      output: 'denied'
    })
    const ok = await svc.resolve('h-1', 'accept')
    expect(ok).toBe(true)
    expect(spies.runApprovedHostCommand).toHaveBeenCalledWith('h-1')
    // runApprovedHostCommand is expected to delete + execute; the
    // service shouldn't double-delete.
    expect(spies.sendAgentCompatLine).not.toHaveBeenCalled()
  })

  it('HostCommand decline: sends warning compat-line and removes the registry', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerHostCommand('h-1', {
      sender: {} as never,
      provider: 'codex',
      command: 'rm -rf /',
      commandText: 'rm -rf /',
      cwd: '/tmp',
      threadId: 't-1',
      model: 'm-1',
      reason: 'sandbox',
      output: 'denied'
    })
    await svc.resolve('h-1', 'decline')
    expect(spies.runApprovedHostCommand).not.toHaveBeenCalled()
    expect(spies.sendAgentCompatLine).toHaveBeenCalledWith(
      expect.anything(),
      'codex',
      expect.objectContaining({ type: 'tool_result', status: 'warning' }),
      expect.anything()
    )
    expect(svc.has('h-1')).toBe(false)
  })

  it('Kimi: routes the wire response based on action', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    const childKill = vi.fn()
    svc.registerKimi('k-1', {
      child: { kill: childKill } as never,
      rpcId: 42,
      params: { payload: { id: 'kimi-req-1' } },
      runId: 'r-1'
    })
    await svc.resolve('k-1', 'accept')
    expect(spies.respondToKimiWireRequest).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.objectContaining({ request_id: 'kimi-req-1', response: 'approve' })
    )
    expect(spies.permissionService.applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'kimi',
        action: 'accept'
      })
    )
    expect(childKill).not.toHaveBeenCalled()
  })

  it('Kimi: persists session/workspace grants through PermissionService', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerKimi('k-1', {
      child: { kill: vi.fn() } as never,
      rpcId: 42,
      params: { payload: { id: 'kimi-req-1' } },
      service: 'mcpTools',
      workspacePath: '/ws',
      runId: 'r-1'
    })
    await svc.resolve('k-1', 'acceptForWorkspace')
    expect(spies.permissionService.applyApprovalDecision).toHaveBeenCalledWith({
      provider: 'kimi',
      workspacePath: '/ws',
      service: 'mcpTools',
      runId: 'r-1',
      action: 'acceptForWorkspace'
    })
    expect(spies.respondToKimiWireRequest).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.objectContaining({ request_id: 'kimi-req-1', response: 'approve_for_session' })
    )
  })

  it('Kimi: decline rejects the pending wire request', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerKimi('k-1', {
      child: { kill: vi.fn() } as never,
      rpcId: 42,
      params: { payload: { id: 'kimi-req-1' } },
      service: 'mcpTools',
      workspacePath: '/ws',
      runId: 'r-1'
    })
    await svc.resolve('k-1', 'decline')
    expect(spies.respondToKimiWireRequest).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.objectContaining({ request_id: 'kimi-req-1', response: 'reject' })
    )
  })

  it('Kimi: external path grant actions approve the pending wire request', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerKimi('k-1', {
      child: { kill: vi.fn() } as never,
      rpcId: 42,
      params: { payload: { id: 'kimi-req-1' } },
      runId: 'r-1',
      externalPathDetection: {
        provider: 'kimi',
        path: '/outside/file.ts',
        access: 'write',
        basename: 'file.ts',
        appChatId: 'chat-1'
      }
    })
    await svc.resolve('k-1', 'grantExternalPathEdit')
    expect(spies.respondToKimiWireRequest).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.objectContaining({ request_id: 'kimi-req-1', response: 'approve' })
    )
  })

  it('Kimi cancel kills the child process', async () => {
    const { deps } = makeDeps()
    const cliMap = new Map<string, unknown>()
    const childKill = vi.fn()
    const child = { kill: childKill } as never
    cliMap.set('kimi', child)
    deps.cliProviderProcesses = cliMap as never
    const svc = new ApprovalService(deps)
    svc.registerKimi('k-1', { child, rpcId: 1, params: {} })
    await svc.resolve('k-1', 'cancel')
    expect(childKill).toHaveBeenCalled()
    expect(cliMap.has('kimi')).toBe(false)
  })

  it('Codex permission: respond with permissions + scope on accept', async () => {
    const { deps, spies } = makeDeps()
    spies.permissionService.applyApprovalDecision.mockReturnValue(true)
    const svc = new ApprovalService(deps)
    const codexParams = { permissions: { read: true } }
    const codex: PendingCodexApproval = {
      rpcId: 99,
      method: 'item/permissions/requestApproval',
      params: codexParams,
      service: 'shellCommands',
      workspacePath: '/ws',
      runId: 'r-1'
    }
    svc.registerCodex('c-1', codex)
    spies.publishApprovalRunEvent.mockClear()
    await svc.resolve('c-1', 'accept')
    expect(spies.codexClient.respond).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ scope: 'turn', permissions: codexParams.permissions })
    )
    expect(spies.publishApprovalRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approval_resolved',
        approvalId: 'c-1',
        provider: 'codex',
        workspaceId: '/ws',
        appRunId: 'r-1',
        appChatId: 'c-1',
        threadId: 'c-1',
        action: 'accept',
        decisionSource: 'user'
      })
    )
  })

  it('Codex elicitation: respond with action + content', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerCodex('c-1', {
      rpcId: 7,
      method: 'mcp/elicitation/request',
      params: {}
    })
    await svc.resolve('c-1', 'acceptForSession', { userInput: 'the answer is 42' })
    expect(spies.codexClient.respond).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'accept', content: 'the answer is 42' })
    )
  })

  it('Codex elicitation (mcpServer/* variant): respond with action + content', async () => {
    // Newer Codex CLI builds rename the method to `mcpServer/elicitation/request`
    // and deserialise the host's response as `McpServerElicitationRequestResponse`.
    // The response shape is identical to the old `mcp/elicitation/request`, so
    // the resolve path must accept both names — otherwise the host falls through
    // to `{ decision: action }` (wrong shape) and Codex rejects the tool call
    // with `missing field 'action'`, surfaced to the user as
    // "user rejected MCP tool call".
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerCodex('c-1', {
      rpcId: 9,
      method: 'mcpServer/elicitation/request',
      params: {}
    })
    await svc.resolve('c-1', 'accept', { userInput: 'sure, proceed' })
    expect(spies.codexClient.respond).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ action: 'accept', content: 'sure, proceed' })
    )
    // And the rejection path also lands the right shape (no `decision`
    // field leaking through to confuse Codex's deserialiser).
    svc.registerCodex('c-2', {
      rpcId: 10,
      method: 'mcpServer/elicitation/request',
      params: {}
    })
    await svc.resolve('c-2', 'decline')
    expect(spies.codexClient.respond).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ action: 'decline' })
    )
  })

  it('Codex requestUserInput accept: respond with answers.default', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerCodex('c-1', {
      rpcId: 11,
      method: 'tool/requestUserInput',
      params: {}
    })
    await svc.resolve('c-1', 'accept', { userInput: 'forty two' })
    expect(spies.codexClient.respond).toHaveBeenCalledWith(
      11,
      expect.objectContaining({ answers: { default: 'forty two' } })
    )
  })

  it('returns false when codex client is unavailable', async () => {
    const { deps, spies } = makeDeps({ getCodexClient: () => null })
    const svc = new ApprovalService(deps)
    svc.registerCodex('c-1', { rpcId: 1, method: 'item/permissions/requestApproval', params: {} })
    spies.publishApprovalRunEvent.mockClear()
    const ok = await svc.resolve('c-1', 'accept')
    expect(ok).toBe(false)
    expect(spies.publishApprovalRunEvent).not.toHaveBeenCalled()
  })

  it('auto-deny path: decisionSource=system + extraMetadata threaded through', async () => {
    const { deps, spies } = makeDeps()
    const svc = new ApprovalService(deps)
    svc.registerMain('m-1', { provider: 'gemini', resolve: vi.fn() })
    await svc.resolve('m-1', 'decline', {
      decisionSource: 'system',
      extraMetadata: {
        autoDeniedByTimeout: true,
        timeoutMs: 30_000,
        timeoutSource: 'providerDefault'
      }
    })
    expect(spies.resolveApprovalLedger).toHaveBeenCalledWith(
      'm-1',
      'decline',
      'system',
      expect.objectContaining({ autoDeniedByTimeout: true, timeoutMs: 30_000 })
    )
  })
})

describe('ApprovalService — wake-push gating', () => {
  it('no-op when no tokens registered', () => {
    const { deps } = makeDeps()
    const svc = new ApprovalService(deps)
    expect(() =>
      svc.notifyPairedDevices({
        approvalId: 'a-1',
        workspaceId: 'w-1',
        threadId: 't-1',
        summary: 'Run X?'
      })
    ).not.toThrow()
  })

  it('suppresses pushes when user is at desktop', async () => {
    const tokenStore = {
      list: vi.fn(() => [{ pairID: 'p-1', deviceToken: 'token', env: 'sandbox' as const }]),
      remove: vi.fn()
    }
    const pusher = {
      pushRemoteAttentionToToken: vi.fn(async () => ({
        delivered: true,
        apnsId: 'apns-1',
        reason: 'sent'
      }))
    }
    const { deps, spies } = makeDeps({
      getApnsPusher: () => pusher as never,
      getApnsTokenStore: () => tokenStore as never,
      isUserAtDesktop: () => true
    })
    const svc = new ApprovalService(deps)
    svc.notifyPairedDevices({
      approvalId: 'a-1',
      workspaceId: 'w-1',
      threadId: 't-1',
      summary: 'Run X?'
    })
    // Microtask flush so any async work would run.
    await new Promise((r) => setTimeout(r, 0))
    expect(pusher.pushRemoteAttentionToToken).not.toHaveBeenCalled()
    expect(spies.log).toHaveBeenCalledWith(expect.stringContaining('user is at desktop'))
  })

  it('fires push when user is away from desktop', async () => {
    const tokenStore = {
      list: vi.fn(() => [{ pairID: 'p-1', deviceToken: 'token-1', env: 'production' as const }]),
      remove: vi.fn()
    }
    const pushFn = vi.fn(async () => ({ delivered: true, apnsId: 'apns-1', reason: '' }))
    const { deps } = makeDeps({
      getApnsPusher: () => ({ pushRemoteAttentionToToken: pushFn }) as never,
      getApnsTokenStore: () => tokenStore as never,
      isUserAtDesktop: () => false
    })
    const svc = new ApprovalService(deps)
    svc.notifyPairedDevices({
      approvalId: 'a-1',
      workspaceId: 'w-1',
      threadId: 't-1',
      summary: 'Approve me'
    })
    // Push fan-out is fire-and-forget async; flush microtasks.
    await new Promise((r) => setTimeout(r, 10))
    expect(pushFn).toHaveBeenCalledWith(
      'token-1',
      'production',
      expect.objectContaining({
        pairID: 'p-1',
        reason: 'approval',
        workspaceId: 'w-1',
        threadId: 't-1',
        approvalId: 'a-1'
      })
    )
    const calls = pushFn.mock.calls as unknown as AttentionPushCall[]
    const payload = calls[0][2] as unknown as Record<string, unknown>
    expect(payload.summary).toBeUndefined()
  })

  it('prunes dead tokens on Apple Unregistered', async () => {
    const tokenStore = {
      list: vi.fn(() => [{ pairID: 'p-dead', deviceToken: 'rotten', env: 'production' as const }]),
      remove: vi.fn()
    }
    const pushFn = vi.fn(async () => ({ delivered: false, apnsId: '', reason: 'Unregistered' }))
    const { deps } = makeDeps({
      getApnsPusher: () => ({ pushRemoteAttentionToToken: pushFn }) as never,
      getApnsTokenStore: () => tokenStore as never,
      isUserAtDesktop: () => false
    })
    const svc = new ApprovalService(deps)
    svc.notifyPairedDevices({
      approvalId: 'a-1',
      workspaceId: 'w-1',
      threadId: 't-1',
      summary: 'foo'
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(tokenStore.remove).toHaveBeenCalledWith('p-dead')
  })
})
