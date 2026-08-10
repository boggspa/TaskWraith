import { describe, expect, it, vi } from 'vitest'
import { ApprovalService, type ApprovalServiceDeps } from './ApprovalService'
import type { AgentApprovalAction } from '../store/types'

function makeDeps(): {
  deps: ApprovalServiceDeps
  spies: {
    applyApprovalDecision: ReturnType<typeof vi.fn>
    isApprovedAction: ReturnType<typeof vi.fn>
    appendDurableRunEventForRoute: ReturnType<typeof vi.fn>
    resolveApprovalLedger: ReturnType<typeof vi.fn>
    respondToKimiWireRequest: ReturnType<typeof vi.fn>
    runApprovedHostCommand: ReturnType<typeof vi.fn>
    codexRespond: ReturnType<typeof vi.fn>
    codexReject: ReturnType<typeof vi.fn>
    log: ReturnType<typeof vi.fn>
  }
} {
  const spies = {
    applyApprovalDecision: vi.fn(() => true),
    isApprovedAction: vi.fn((action: AgentApprovalAction) =>
      ['accept', 'acceptForSession', 'acceptForWorkspace'].includes(action)
    ),
    appendDurableRunEventForRoute: vi.fn(),
    resolveApprovalLedger: vi.fn(),
    respondToKimiWireRequest: vi.fn(),
    runApprovedHostCommand: vi.fn(async () => true),
    codexRespond: vi.fn(),
    codexReject: vi.fn(),
    log: vi.fn()
  }
  return {
    spies,
    deps: {
      runManager: {
        get: vi.fn(() => ({ runId: 'run-1', appChatId: 'chat-1', status: 'running' })),
        resolveApproval: vi.fn(() => ({ runId: 'run-1', appChatId: 'chat-1' })),
        clearApproval: vi.fn()
      } as never,
      permissionService: {
        applyApprovalDecision: spies.applyApprovalDecision,
        isApprovedAction: spies.isApprovedAction
      } as never,
      appendDurableRunEventForRoute: spies.appendDurableRunEventForRoute,
      resolveApprovalLedger: spies.resolveApprovalLedger,
      getCodexClient: () => ({
        respond: spies.codexRespond,
        reject: spies.codexReject
      }),
      sendAgentCompatLine: vi.fn(),
      respondToKimiWireRequest: spies.respondToKimiWireRequest as never,
      runApprovedHostCommand: spies.runApprovedHostCommand,
      cliProviderProcesses: new Map(),
      getApnsPusher: () => null,
      getApnsTokenStore: () => null,
      isUserAtDesktop: () => false,
      workspaceIdForPath: (workspacePath?: string) => workspacePath ?? null,
      publishApprovalRunEvent: vi.fn(),
      getApprovalTimeoutSettings: vi.fn(() => ({
        enabled: false,
        perProviderMs: {
          gemini: 120_000,
          codex: 30_000,
          claude: 120_000,
          kimi: 60_000,
          grok: 120_000,
          cursor: 120_000,
          ollama: 120_000,
          antigravity: 120_000,
          pi: 120_000,
          mistral: 120_000,
          muse: 120_000
        },
        mainAuthorityMs: 60_000
      })),
      log: spies.log
    }
  }
}

describe('ApprovalService M3 approval choke-point gates', () => {
  it('rejects unoffered accept actions for a read-only denial card without resolving it', async () => {
    const { deps, spies } = makeDeps()
    const service = new ApprovalService(deps)
    const resolve = vi.fn()
    expect(
      service.registerGeminiTool('approval-readonly', {
        provider: 'codex',
        service: 'fileChanges',
        workspacePath: '/repo',
        runId: 'run-1',
        allowedActions: ['decline', 'cancel'],
        resolve
      })
    ).toBe(true)

    await expect(service.resolve('approval-readonly', 'accept')).resolves.toBe(false)

    expect(service.has('approval-readonly')).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
    expect(spies.applyApprovalDecision).not.toHaveBeenCalled()
    expect(spies.resolveApprovalLedger).not.toHaveBeenCalled()
    expect(spies.log).toHaveBeenCalledWith(
      expect.stringContaining('rejected invalid approval action "accept"')
    )
  })

  it('rejects unoffered grant actions for non-grantable services without applying grants', async () => {
    const { deps, spies } = makeDeps()
    const service = new ApprovalService(deps)
    const resolve = vi.fn()
    expect(
      service.registerGeminiTool('approval-non-grantable', {
        provider: 'gemini',
        service: 'canvasEval',
        workspacePath: '/repo',
        runId: 'run-1',
        allowedActions: ['accept', 'decline'],
        resolve
      })
    ).toBe(true)

    await expect(service.resolve('approval-non-grantable', 'grantExternalPathEdit')).resolves.toBe(
      false
    )

    expect(service.has('approval-non-grantable')).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
    expect(spies.applyApprovalDecision).not.toHaveBeenCalled()
    expect(spies.resolveApprovalLedger).not.toHaveBeenCalled()
    expect(spies.log).toHaveBeenCalledWith(
      expect.stringContaining('rejected invalid approval action "grantExternalPathEdit"')
    )
  })
})
