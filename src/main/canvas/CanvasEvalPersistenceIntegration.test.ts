// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import { PermissionService } from '../PermissionService'
import { RunManager } from '../RunManager'
import { createApprovalOrchestration } from '../run/ApprovalOrchestration'
import { ApprovalService } from '../services/ApprovalService'
import { AuditService } from '../services/AuditService'
import { CanvasService } from './CanvasService'
import { CanvasStore } from './CanvasStore'
import { createCanvasEvalApprovalReceipt, type CanvasEvalApprovalReceipt } from './CanvasEvalAudit'
import type { CanvasDriver, CanvasEvalResult } from './canvasTypes'

const userDataPath = vi.hoisted(
  () => `/tmp/taskwraith-canvas-persistence-integration-${process.pid}`
)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath,
    getVersion: () => '1.0.0'
  }
}))

describe('canvas_eval persisted approval and execution receipts', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
  })

  afterEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
  })

  it('binds prompt, run event, ledger decision, and Canvas events to one host receipt', async () => {
    const runManager = new RunManager()
    runManager.create({
      runId: 'run-canvas-e2e',
      provider: 'claude',
      appChatId: 'chat-canvas-e2e',
      workspacePath: '/repo',
      status: 'running',
      state: {}
    })
    const permissionService = new PermissionService({
      runManager,
      sessionGrants: new Set(),
      getSettings: () => AppStore.getSettings(),
      updateSettings: (partial) => AppStore.updateSettings(partial)
    })
    const appendRunEvent = (
      provider: 'claude',
      route: { appRunId?: string; appChatId?: string } | null | undefined,
      kind: any,
      phase: any,
      summary: string,
      payload?: unknown
    ) => {
      AppStore.appendRunEvent({
        runId: route?.appRunId || 'run-canvas-e2e',
        chatId: route?.appChatId,
        workspaceId: 'workspace-e2e',
        workspacePath: '/repo',
        provider,
        kind,
        phase,
        source: 'main',
        summary,
        payload
      })
    }
    const auditService = new AuditService({
      runManager,
      resolveApprovalResponse: (approvalId, action, decisionSource, metadata) =>
        AppStore.resolveApprovalRequest(approvalId, action, decisionSource, metadata),
      recordApprovalLedgerDecision: (input) => AppStore.recordApprovalRequest(input),
      approvalRouteContext: () => ({
        runId: 'run-canvas-e2e',
        chatId: 'chat-canvas-e2e',
        workspaceId: 'workspace-e2e',
        workspacePath: '/repo'
      })
    })
    const approvalService = new ApprovalService({
      runManager,
      permissionService,
      appendDurableRunEventForRoute: appendRunEvent as never,
      resolveApprovalLedger: auditService.resolveApprovalLedgerResponse.bind(auditService),
      resolveApprovalLedgerStrict:
        auditService.resolveApprovalLedgerResponseStrict.bind(auditService),
      getCodexClient: () => null,
      sendAgentCompatLine: vi.fn(),
      respondToKimiWireRequest: vi.fn(),
      runApprovedHostCommand: vi.fn(async () => false),
      cliProviderProcesses: new Map(),
      getApnsPusher: () => null,
      getApnsTokenStore: () => null,
      isUserAtDesktop: () => true,
      workspaceIdForPath: () => 'workspace-e2e',
      publishApprovalRunEvent: vi.fn(),
      getApprovalTimeoutSettings: () => ({
        enabled: false,
        perProviderMs: {
          gemini: 1,
          codex: 1,
          claude: 1,
          kimi: 1,
          grok: 1,
          cursor: 1,
          ollama: 1,
          antigravity: 1,
          pi: 1
        },
        mainAuthorityMs: 1
      }),
      log: vi.fn()
    })
    const liveCards: any[] = []
    const requestApproval = createApprovalOrchestration({
      runManager,
      permissionService,
      auditService,
      getApprovalService: () => approvalService,
      getSettings: () => AppStore.getSettings(),
      appendDurableRunEventForRoute: appendRunEvent as never,
      recordApprovalLedgerRequest: (_provider, route, payload, options) => {
        const approvalId = String(payload.approvalId || payload.id || '')
        permissionService.recordApprovalRequest({
          approvalId,
          provider: 'claude',
          service: options?.service,
          method: payload.method || 'claude-mcp/canvas_eval',
          title: payload.title || 'Approve Canvas eval',
          body: payload.body,
          preview: payload.preview,
          params: payload.params,
          actions: payload.actions || [],
          runId: route?.appRunId,
          chatId: route?.appChatId,
          workspaceId: 'workspace-e2e',
          workspacePath: options?.workspacePath,
          metadata: options?.metadata
        })
      },
      safeSendToSender: (_sender, channel, payload) => {
        if (channel === 'agent-approval-request') liveCards.push(payload)
        return true
      },
      isSessionYoloEffective: () => false,
      sessionYoloState: { enabled: false, enabledAt: null },
      scheduleApprovalTimeout: vi.fn(),
      workspaceIdForApprovalPush: () => 'workspace-e2e',
      notifyPairedDevicesOfApproval: vi.fn(),
      networkAccessBlockedToolName: () => null,
      networkAccessBlockedMessage: (toolName) => `${toolName} blocked`,
      canAutoApproveTrustedSessionExternalWrite: () => false,
      ensembleApprovalContext: () => undefined,
      planArtifactWriteApprovalMetadata: () => null,
      stampPlanArtifactPathOnPendingPlan: vi.fn(),
      bossmanAutoApprovalMetadata: () => null,
      externalPathApprovalTitle: () => 'External path',
      externalPathApprovalBody: () => 'External path',
      externalPathApprovalPreview: (detection) => ({
        path: detection.path,
        basename: detection.basename,
        access: detection.access
      })
    })

    const script = 'return "\uD800\uFE0F-PERSISTENCE-SECRET"'
    let receipt: CanvasEvalApprovalReceipt | undefined
    const pending = requestApproval(
      { isDestroyed: () => false } as never,
      'claude',
      'canvasEval',
      '/repo',
      {
        method: 'claude-mcp/canvas_eval',
        title: 'Approve Canvas eval',
        body: 'Review the exact script',
        runId: 'run-canvas-e2e',
        preview: {
          kind: 'tool',
          toolName: 'canvas_eval',
          params: { canvasId: 'canvas-e2e', script }
        },
        onApprovalPromptCreated: ({ approvalId }) => {
          receipt = createCanvasEvalApprovalReceipt(script, approvalId)
          return receipt
        }
      }
    )
    await Promise.resolve()

    expect(receipt).toBeDefined()
    const approvalId = receipt!.approvalId
    const pendingLedger = AppStore.getApprovalLedger({ approvalId })[0]
    const approvalRunEvent = AppStore.getRunEvents({ runId: 'run-canvas-e2e' }).find(
      (event) => event.kind === 'approval_request'
    )
    expect(liveCards[0]).toMatchObject({ approvalId })
    expect((approvalRunEvent?.payload as any)?.preview?.canvasEvalReceipt).toEqual(receipt)
    expect((pendingLedger?.preview as any)?.canvasEvalReceipt).toEqual(receipt)
    expect(JSON.stringify(approvalRunEvent)).not.toContain('PERSISTENCE-SECRET')
    expect(JSON.stringify(pendingLedger)).not.toContain('PERSISTENCE-SECRET')

    expect(await approvalService.resolve(approvalId, 'accept')).toBe(true)
    expect(await pending).toBe(true)
    expect(AppStore.getApprovalLedger({ approvalId })[0]).toMatchObject({
      approvalId,
      status: 'approved',
      decision: 'accept'
    })

    let evaluatedScript = ''
    const evalResult: CanvasEvalResult = {
      ok: true,
      valueType: 'string',
      value: 'provider-result',
      truncated: false
    }
    const driver = {
      kind: 'sketch',
      open: vi.fn(async () => ({
        url: 'sketch://new',
        title: 'E2E Canvas',
        viewport: { width: 800, height: 600 }
      })),
      evaluate: vi.fn(async ({ script: exactScript }: { script: string }) => {
        evaluatedScript = exactScript
        return evalResult
      }),
      close: vi.fn(async () => undefined)
    } as unknown as CanvasDriver
    let uuidSequence = 0
    const canvasStore = new CanvasStore(join(userDataPath, 'canvas'))
    const canvasService = new CanvasService({
      createDriver: () => driver,
      store: canvasStore,
      uuid: () => `canvas-e2e-${++uuidSequence}`,
      now: () => '2026-07-19T00:00:00.000Z'
    })
    const context = {
      provider: 'claude' as const,
      chatId: 'chat-canvas-e2e',
      runId: 'run-canvas-e2e',
      workspacePath: '/repo',
      canvasEvalApproval: receipt
    }
    const opened = await canvasService.open({ driver: 'sketch' }, context)
    expect(await canvasService.evaluate(opened.canvasId, { script }, context)).toEqual(evalResult)
    expect(evaluatedScript).toBe(script)

    const evalEvents = canvasStore
      .listEvents(opened.canvasId)
      .filter((event) => event.kind === 'eval.started' || event.kind === 'eval.completed')
    expect(evalEvents).toHaveLength(2)
    for (const event of evalEvents) {
      expect(event.approvalId).toBe(approvalId)
      expect(event.detail).toMatchObject({
        approvalId,
        scriptHashAlgorithm: receipt!.scriptHashAlgorithm,
        scriptHash: receipt!.scriptHash,
        scriptLength: receipt!.scriptLength,
        scriptByteLength: receipt!.scriptByteLength
      })
      expect(JSON.stringify(event)).not.toContain('PERSISTENCE-SECRET')
    }
    expect(evalEvents[0].kind).toBe('eval.started')
    expect(evalEvents[1]).toMatchObject({
      kind: 'eval.completed',
      detail: { outcome: 'success', ok: true }
    })
  })
})
