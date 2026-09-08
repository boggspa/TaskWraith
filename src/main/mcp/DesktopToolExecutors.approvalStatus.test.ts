import { describe, expect, it, vi } from 'vitest'
import type { EffectiveRunPermissions } from '../store/types'
import { createKimiGatewayReadiness } from '../kimi/KimiGatewayReadiness'
import { createKimiRunCapabilityReceipt } from '../kimi/KimiRunCapabilities'
import { createDesktopToolExecutors, type DesktopToolExecutorDeps } from './DesktopToolExecutors'

function fixture() {
  const configured = { fileChanges: 'deny', shellCommands: 'ask', mcpTools: 'allow' }
  const runServices = { fileChanges: 'allow', shellCommands: 'allow', mcpTools: 'allow' }
  const permissions = {
    presetId: 'workspace_write',
    readOnly: false,
    agenticServices: runServices
  } as EffectiveRunPermissions
  const receipt = createKimiRunCapabilityReceipt(
    {
      runId: 'kimi-run',
      chatId: 'chat',
      permissions,
      assignedScope: { kind: 'lane', paths: [{ kind: 'path', path: 'src/owned.ts' }] }
    },
    createKimiGatewayReadiness().snapshot()
  )
  receipt.refusals = [
    {
      toolCallId: 'tool-1',
      toolName: 'Edit',
      source: 'host-containment',
      decisionSource: 'system',
      userAsked: false,
      timestamp: '2026-09-08T18:00:00Z'
    }
  ]
  const ledger = vi.fn(() => [])
  const events = vi.fn(() => {
    throw new Error('Synchronous history reads are forbidden here')
  })
  const readReceipt = vi.fn(async () => receipt)
  let chatAvailable = true
  const deps = {
    store: {
      getSettings: () => ({ agenticServices: configured, agenticWorkspaceGrants: [] }),
      getApprovalLedger: ledger,
      getChat: () =>
        chatAvailable
          ? {
              appChatId: 'chat',
              runs: [
                {
                  runId: 'kimi-run',
                  provider: 'kimi',
                  permissionPosture: { agenticServices: runServices }
                }
              ]
            }
          : null
    },
    runRepository: { getRunEvents: events },
    readKimiCapabilityReceipt: readReceipt
  } as unknown as DesktopToolExecutorDeps
  const executor = createDesktopToolExecutors(deps)
  const context = {
    scope: 'workspace' as const,
    cwd: '/workspace',
    appChatId: 'chat',
    appRunId: 'capt-run'
  }
  return {
    executor,
    context,
    configured,
    runServices,
    receipt,
    ledger,
    events,
    readReceipt,
    deleteChat: () => {
      chatAvailable = false
    }
  }
}

describe('approval_status exact-run evidence', () => {
  it('drops a pending durable receipt when the active chat is deleted during lookup', async () => {
    const { executor, context, configured, receipt, readReceipt, deleteChat } = fixture()
    let release!: (value: typeof receipt) => void
    readReceipt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = executor.executeApprovalStatus(context, { runId: 'kimi-run' }, 'codex')
    deleteChat()
    release(receipt)
    const result = await pending
    expect(result.capabilityReceipt).toBeNull()
    expect(result.servicesSource).toBe('configured-defaults')
    expect(result.services).toEqual(configured)
  })

  it('gives Captain the worker run posture and capability receipt while separating system refusals', async () => {
    const { executor, context, configured, runServices, receipt, ledger } = fixture()
    const result = await executor.executeApprovalStatus(context, { runId: 'kimi-run' }, 'codex')
    expect(result.provider).toBe('kimi')
    expect(result.services).toEqual(runServices)
    expect(result.servicesSource).toBe('recorded-run-posture')
    expect(result.configuredServices).toEqual(configured)
    expect(result.capabilityReceipt).toEqual(receipt)
    expect(result.count).toBe(0)
    expect(result.capabilityReceipt!.refusals[0].userAsked).toBe(false)
    expect(ledger).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'kimi', runId: 'kimi-run', chatId: 'chat' })
    )
    const worker = await executor.executeApprovalStatus(
      { ...context, appRunId: 'kimi-run' },
      {},
      'kimi'
    )
    expect(worker.capabilityReceipt).toEqual(result.capabilityReceipt)
  })

  it('labels configured defaults and never invents a catalogue for aggregate or unavailable runs', async () => {
    const { executor, context, configured, events } = fixture()
    const all = await executor.executeApprovalStatus(context, { all: true }, 'codex')
    expect(all.services).toEqual(configured)
    expect(all.servicesSource).toBe('configured-defaults')
    expect(all.capabilityReceiptStatus).toBe('query-not-run-scoped')
    const unavailable = await executor.executeApprovalStatus(
      context,
      { runId: 'other-run', provider: 'kimi' },
      'codex'
    )
    expect(unavailable.capabilityReceipt).toBeNull()
    expect(events).not.toHaveBeenCalled()
  })

  it('does not expose active-chat capabilities under a different explicit chat or provider', async () => {
    const { executor, context, events } = fixture()
    expect(
      (
        await executor.executeApprovalStatus(
          context,
          { runId: 'kimi-run', chatId: 'other-chat' },
          'codex'
        )
      ).capabilityReceipt
    ).toBeNull()
    expect(
      (
        await executor.executeApprovalStatus(
          context,
          { runId: 'kimi-run', provider: 'codex' },
          'codex'
        )
      ).capabilityReceipt
    ).toBeNull()
    expect(events).not.toHaveBeenCalled()
  })
})
