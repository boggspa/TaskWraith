// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createApprovalOrchestration,
  createMainApprovalOrchestration,
  type RequestAgenticServiceApprovalDeps
} from './ApprovalOrchestration'
import { createCanvasEvalApprovalReceipt } from '../canvas/CanvasEvalAudit'

/**
 * M3-3b SECURITY wrapper net for the relocated approval orchestrator (the trust
 * choke point). `ApprovalServiceM3Gate` only fences `ApprovalService.resolve()`;
 * it never covers this 306-line orchestration. This test fences the guard
 * SEQUENCE + branch dispositions, because the risk in relocating a
 * security-sensitive orchestrator is reordering / dropping a guard — a security
 * regression, not a behaviour change.
 *
 * The 4 pure cross-module helpers are direct-imported in the module → vi.mock
 * them (M3-1b/M3-2b precedent). Every injected dep logs to a shared `order` array
 * so ordering can be asserted directly.
 *
 * Coverage maps to the five ordering invariants:
 *   #1 network-block BEFORE resolve            → case (a)
 *   #2 policy DENY is absolute (before yolo)    → case (b)
 *   #3 plan-artifact fast-path AFTER resolve,
 *      BEFORE the plain deny                    → case (c)
 *   #4 registerGeminiTool opens the REGISTER
 *      sequence, read live via getApprovalService → case (g)
 *   #5 neverAutoAllow forces a prompt           → case (h)
 * plus yolo (d), standing-grant (e), bossman (f).
 */

vi.mock('../NativeApprovalPolicy', () => ({
  effectiveAgenticSettings: vi.fn(() => ({ agenticServices: {} }))
}))
vi.mock('../AgenticServiceMessages', () => ({
  agenticServiceBlockedMessage: vi.fn(() => 'service blocked'),
  approvalActionsForPolicy: vi.fn(() => ['accept', 'decline', 'cancel'])
}))
vi.mock('../EffectiveRunPermissions', () => ({
  isPlanInstrumentGrantHold: vi.fn(() => false),
  isPostureApprovalOnlyService: vi.fn(() => false)
}))

import { effectiveAgenticSettings } from '../NativeApprovalPolicy'
import { approvalActionsForPolicy } from '../AgenticServiceMessages'
import { isPlanInstrumentGrantHold, isPostureApprovalOnlyService } from '../EffectiveRunPermissions'

type Resolution = {
  policy: string
  workspaceGrantAllowed: boolean
  sessionGrantAllowed: boolean
  decision: string
}

function makeDeps(order: string[]): RequestAgenticServiceApprovalDeps {
  return {
    runManager: {
      get: vi.fn((runId?: string) =>
        runId ? { runId, appChatId: 'chat-1', status: 'running', state: {} } : undefined
      ),
      getClaimedTerminalStatus: vi.fn(() => undefined),
      registerApproval: vi.fn(() => {
        order.push('runManager.registerApproval')
      })
    } as never,
    permissionService: {
      resolvePermission: vi.fn((): Resolution => {
        order.push('permissionService.resolvePermission')
        return {
          policy: 'ask',
          workspaceGrantAllowed: false,
          sessionGrantAllowed: false,
          decision: 'ask'
        }
      })
    } as never,
    auditService: {
      recordAutomaticApprovalDecision: vi.fn((...args: unknown[]) => {
        // args[5] = disposition (autoAllow/autoDeny), args[6] = reason
        order.push(`audit:${String(args[5])}:${String(args[6])}`)
      })
    } as never,
    getApprovalService: vi.fn(() => {
      order.push('getApprovalService')
      return {
        registerGeminiTool: vi.fn(() => {
          order.push('registerGeminiTool')
        }),
        registerMain: vi.fn(() => {
          order.push('registerMain')
        })
      }
    }) as never,
    getSettings: vi.fn(() => ({ agenticServices: {} })) as never,
    appendDurableRunEventForRoute: vi.fn(() => {
      order.push('appendDurableRunEventForRoute')
    }),
    recordApprovalLedgerRequest: vi.fn(() => {
      order.push('recordApprovalLedgerRequest')
    }),
    safeSendToSender: vi.fn((_sender: unknown, channel: string) => {
      order.push(`safeSendToSender:${channel}`)
      return true
    }) as never,
    isSessionYoloEffective: vi.fn(() => false),
    sessionYoloState: { enabled: false, enabledAt: null },
    scheduleApprovalTimeout: vi.fn(() => {
      order.push('scheduleApprovalTimeout')
    }),
    workspaceIdForApprovalPush: vi.fn(() => 'ws-1'),
    notifyPairedDevicesOfApproval: vi.fn(() => {
      order.push('notifyPairedDevicesOfApproval')
    }),
    networkAccessBlockedToolName: vi.fn(() => null),
    networkAccessBlockedMessage: vi.fn((t: string) => `${t} blocked`),
    canAutoApproveTrustedSessionExternalWrite: vi.fn(() => false),
    ensembleApprovalContext: vi.fn(() => undefined),
    planArtifactWriteApprovalMetadata: vi.fn(() => null),
    stampPlanArtifactPathOnPendingPlan: vi.fn(() => {
      order.push('stampPlanArtifactPathOnPendingPlan')
    }),
    bossmanAutoApprovalMetadata: vi.fn(() => null),
    externalPathApprovalTitle: vi.fn(() => 'External path'),
    externalPathApprovalBody: vi.fn(() => 'ext body'),
    externalPathApprovalPreview: vi.fn(() => ({ path: '/x', access: 'read' as const }))
  }
}

const sender = { isDestroyed: () => false, send: vi.fn() } as never

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'gemini-mcp/tool',
    title: 'Approve tool',
    body: 'tool body',
    runId: 'run-1',
    ...overrides
  } as never
}

// Override resolvePermission while PRESERVING the default order-log, so tests
// that assert ordering vs resolve still observe the resolve step.
function setResolution(
  deps: RequestAgenticServiceApprovalDeps,
  order: string[],
  r: Partial<Resolution>
): void {
  vi.mocked(deps.permissionService.resolvePermission).mockImplementation(((): Resolution => {
    order.push('permissionService.resolvePermission')
    return {
      policy: 'ask',
      workspaceGrantAllowed: false,
      sessionGrantAllowed: false,
      decision: 'ask',
      ...r
    }
  }) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(effectiveAgenticSettings).mockReturnValue({ agenticServices: {} } as never)
  vi.mocked(approvalActionsForPolicy).mockReturnValue(['accept', 'decline', 'cancel'] as never)
  vi.mocked(isPlanInstrumentGrantHold).mockReturnValue(false)
  vi.mocked(isPostureApprovalOnlyService).mockReturnValue(false)
})

describe('createApprovalOrchestration — security guard sequence (faked deps)', () => {
  // (a) NETWORK-BLOCK — invariant #1: auto-deny fires BEFORE permission resolution.
  it('(a) network-block auto-denies before resolvePermission and never registers a prompt', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.networkAccessBlockedToolName).mockReturnValue('web_fetch')

    const result = await createApprovalOrchestration(deps)(
      sender,
      'gemini',
      'mcpTools',
      '/repo',
      request({ preview: { toolName: 'web_fetch' } })
    )

    expect(result).toBe(false)
    expect(order).toEqual(['audit:autoDeny:policy', 'safeSendToSender:agent-error'])
    // #1: resolve NEVER runs on the network-block path.
    expect(vi.mocked(deps.permissionService.resolvePermission)).not.toHaveBeenCalled()
    // no prompt registration on a hard deny.
    expect(order).not.toContain('getApprovalService')
    expect(order).not.toContain('registerGeminiTool')
  })

  // (b) POLICY-DENY — invariant #2: deny is ABSOLUTE. Even with session-YOLO
  // effective and a non-read-only posture, an explicit deny still wins.
  it('(b) policy deny is absolute — wins even when session-YOLO is effective', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.permissionService.resolvePermission).mockReturnValue({
      policy: 'deny',
      workspaceGrantAllowed: false,
      sessionGrantAllowed: false,
      decision: 'deny'
    })
    vi.mocked(deps.isSessionYoloEffective).mockReturnValue(true) // YOLO on — must NOT rescue a deny

    const result = await createApprovalOrchestration(deps)(sender, 'gemini', 'mcpTools', '/repo', request())

    expect(result).toBe(false)
    expect(order).toContain('audit:autoDeny:policy')
    expect(order).toContain('safeSendToSender:agent-error')
    // #2: deny short-circuits BEFORE the session_yolo path — no yolo auto-allow.
    expect(order).not.toContain('audit:autoAllow:session_yolo')
    expect(order).not.toContain('registerGeminiTool')
  })

  // (c) PLAN-ARTIFACT — invariant #3: the plan-artifact fast-path sits AFTER
  // resolve and BEFORE the plain deny. A denied decision + plan-artifact metadata
  // auto-allows (markdown plan write) and stamps the pending plan.
  it('(c) plan-artifact write is allowed after resolve, before the plain deny', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'deny', decision: 'deny' })
    vi.mocked(deps.planArtifactWriteApprovalMetadata).mockReturnValue({
      relativePath: 'plan.md',
      workflowMode: 'plan'
    })

    const result = await createApprovalOrchestration(deps)(
      sender,
      'claude',
      'fileChanges',
      '/repo',
      request()
    )

    expect(result).toBe(true)
    // #3: resolve ran first, THEN the plan-artifact allow — and the plain deny
    // branch did NOT fire (no autoDeny recorded).
    expect(order).toEqual([
      'permissionService.resolvePermission',
      'audit:autoAllow:plan_artifact',
      'stampPlanArtifactPathOnPendingPlan'
    ])
    expect(order).not.toContain('audit:autoDeny:policy')
  })

  // (d) SESSION-YOLO — auto-allow when YOLO is effective, not read-only, not
  // forcePrompt, not neverAutoAllow.
  it('(d) session-YOLO auto-allows an otherwise-ask decision', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.isSessionYoloEffective).mockReturnValue(true)

    const result = await createApprovalOrchestration(deps)(sender, 'gemini', 'mcpTools', '/repo', request())

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:session_yolo')
    expect(order).not.toContain('registerGeminiTool') // auto-allowed → no prompt
  })

  // (e) STANDING-GRANT — a workspace grant auto-allows an 'allow' decision with
  // the workspace_grant reason/source.
  it('(e) a workspace standing grant auto-allows without prompting', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.permissionService.resolvePermission).mockReturnValue({
      policy: 'ask',
      workspaceGrantAllowed: true,
      sessionGrantAllowed: false,
      decision: 'allow'
    })

    const result = await createApprovalOrchestration(deps)(sender, 'codex', 'mcpTools', '/repo', request())

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:workspace_grant')
    expect(order).not.toContain('registerGeminiTool')
  })

  it('(e2) auto-allows an external write only when the active Trusted Session scope confirms it', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'allow', decision: 'allow' })
    vi.mocked(deps.canAutoApproveTrustedSessionExternalWrite).mockReturnValue(true)

    const result = await createApprovalOrchestration(deps)(
      sender,
      'claude',
      'fileChanges',
      '/repo',
      request({ externalPathDetection: { provider: 'claude', path: '/tmp/output.txt', access: 'write' } })
    )

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:trusted_session')
    expect(order).not.toContain('registerGeminiTool')
    expect(deps.canAutoApproveTrustedSessionExternalWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        workspacePath: '/repo',
        externalPathDetection: expect.objectContaining({ access: 'write' })
      })
    )
  })

  // (f) BOSSMAN — the ensemble Boss auto-approval path allows when metadata is
  // returned (after deny/yolo/grant paths are exhausted).
  it('(f) bossman auto-approval allows when metadata is present', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.bossmanAutoApprovalMetadata).mockReturnValue({ bossman: 'auto' })

    const result = await createApprovalOrchestration(deps)(sender, 'claude', 'mcpTools', '/repo', request())

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:bossman_auto')
    expect(order).not.toContain('registerGeminiTool')
  })

  // (g) REGISTER — invariant #4: when nothing auto-decides, the prompt is opened
  // and the REGISTER sequence runs in exact order, led by registerGeminiTool read
  // LIVE via getApprovalService (the stale-null capture that M3-3a shipped would
  // have broken exactly this — getApprovalService() returning null → no register).
  it('(g) falls through to a prompt with the REGISTER sequence in order, via live getApprovalService', async () => {
    const order: string[] = []
    const deps = makeDeps(order)

    const promise = createApprovalOrchestration(deps)(sender, 'gemini', 'mcpTools', '/repo', request())
    // The prompt promise only resolves on user action; assert the synchronous
    // registration side-effects, then leave it pending.
    await Promise.resolve()

    const registerSeq = order.filter((o) => o !== 'permissionService.resolvePermission')
    expect(registerSeq).toEqual([
      'getApprovalService',
      'registerGeminiTool',
      'runManager.registerApproval',
      'scheduleApprovalTimeout',
      'appendDurableRunEventForRoute',
      'recordApprovalLedgerRequest',
      'safeSendToSender:agent-approval-request',
      'notifyPairedDevicesOfApproval'
    ])
    // getApprovalService is invoked at call-time (live read), so a real service
    // registers the tool — no stale-null no-op.
    expect(vi.mocked(deps.getApprovalService)).toHaveBeenCalled()
    void promise
  })

  // (g2) REGISTER null-service — no registry means there is nowhere to receive
  // the renderer decision. Fail closed before emitting an orphan card/ledger row.
  it('(g2) a null approval service fails closed before emitting an orphan prompt', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.getApprovalService).mockReturnValue(null as never)

    await expect(
      createApprovalOrchestration(deps)(sender, 'gemini', 'mcpTools', '/repo', request())
    ).resolves.toBe(false)

    expect(vi.mocked(deps.getApprovalService)).toHaveBeenCalled() // live read still happens
    expect(order).not.toContain('registerGeminiTool')
    expect(order).not.toContain('runManager.registerApproval')
    expect(order).not.toContain('safeSendToSender:agent-approval-request')
  })

  // (h) NEVER-AUTO-ALLOW — invariant #5: canvasEval (RCE) is non-grantable. Even
  // with session-YOLO effective AND an 'allow' decision, it must NOT auto-allow —
  // it falls through to a human prompt.
  it('(h) neverAutoAllow (canvasEval) forces a prompt despite YOLO + allow', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.isSessionYoloEffective).mockReturnValue(true)
    vi.mocked(deps.permissionService.resolvePermission).mockReturnValue({
      policy: 'allow',
      workspaceGrantAllowed: true,
      sessionGrantAllowed: false,
      decision: 'allow'
    })

    const script = 'return 1'
    createApprovalOrchestration(deps)(
      sender,
      'claude',
      'canvasEval',
      '/repo',
      request({
        preview: { toolName: 'canvas_eval', params: { script } },
        onApprovalPromptCreated: ({ approvalId }: { approvalId: string }) =>
          createCanvasEvalApprovalReceipt(script, approvalId)
      })
    )
    await Promise.resolve()

    // no auto-allow of any flavour…
    expect(order).not.toContain('audit:autoAllow:session_yolo')
    expect(order).not.toContain('audit:autoAllow:workspace_grant')
    expect(order).not.toContain('audit:autoAllow:bossman_auto')
    // …it reaches the human prompt instead.
    expect(order).toContain('registerGeminiTool')
  })

  it('(h2) posture approval-only publishing prompts request-only despite an allow decision', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(isPostureApprovalOnlyService).mockReturnValue(true)
    vi.mocked(deps.permissionService.resolvePermission).mockReturnValue({
      policy: 'allow',
      workspaceGrantAllowed: false,
      sessionGrantAllowed: false,
      decision: 'allow'
    })

    const pending = createApprovalOrchestration(deps)(
      sender,
      'codex',
      'externalPublish',
      '/repo',
      request()
    )
    await Promise.resolve()

    expect(order).not.toContain('audit:autoAllow:policy')
    expect(order).toContain('registerGeminiTool')
    const livePayload = vi.mocked(deps.safeSendToSender).mock.calls[0]?.[2] as any
    expect(livePayload.actions).toEqual(['accept', 'decline', 'cancel'])
    expect(livePayload.preview).toMatchObject({
      requestOnly: true,
      requestOnlyReason: 'run-posture-approval-only'
    })
    void pending
  })

  it('(i) keeps the exact canvas_eval script transient while durable sinks receive an approval-bound receipt', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    const script = 'document.cookie + "APPROVAL-SECRET"'
    const onApprovalPromptCreated = vi.fn(({ approvalId }: { approvalId: string }) =>
      createCanvasEvalApprovalReceipt(script, approvalId)
    )

    const pending = createApprovalOrchestration(deps)(
      sender,
      'claude',
      'canvasEval',
      '/repo',
      request({
        preview: {
          kind: 'tool',
          toolName: 'canvas_eval',
          params: { canvasId: 'canvas-1', script }
        },
        onApprovalPromptCreated
      })
    )
    await Promise.resolve()

    const livePayload = vi.mocked(deps.safeSendToSender).mock.calls[0]?.[2] as any
    const durableRunPayload = vi.mocked(deps.appendDurableRunEventForRoute).mock.calls[0]?.[5] as any
    const durableLedgerPayload = vi.mocked(deps.recordApprovalLedgerRequest).mock.calls[0]?.[2] as any

    expect(livePayload.preview.params.script).toBe(script)
    expect(JSON.stringify(durableRunPayload)).not.toContain('APPROVAL-SECRET')
    expect(JSON.stringify(durableLedgerPayload)).not.toContain('APPROVAL-SECRET')
    expect(durableRunPayload.preview.canvasEvalReceipt).toEqual(
      durableLedgerPayload.preview.canvasEvalReceipt
    )
    expect(durableRunPayload.preview.canvasEvalReceipt).toMatchObject({
      approvalId: livePayload.approvalId,
      schemaVersion: 2,
      scriptHashAlgorithm: 'sha256-utf16le',
      scriptLength: script.length,
      scriptByteLength: Buffer.byteLength(script, 'utf8')
    })
    expect(onApprovalPromptCreated).toHaveBeenCalledWith({
      approvalId: livePayload.approvalId
    })
    void pending
  })

  it('(j) blocks canvas_eval before registration when the host receipt is missing or mismatched', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    const script = 'return "reviewed"'

    await expect(
      createApprovalOrchestration(deps)(
        sender,
        'claude',
        'canvasEval',
        '/repo',
        request({
          preview: { toolName: 'canvas_eval', params: { script } },
          onApprovalPromptCreated: vi.fn(() => undefined)
        })
      )
    ).resolves.toBe(false)

    await expect(
      createApprovalOrchestration(deps)(
        sender,
        'claude',
        'canvasEval',
        '/repo',
        request({
          preview: { toolName: 'canvas_eval', params: { script } },
          onApprovalPromptCreated: ({ approvalId }: { approvalId: string }) =>
            createCanvasEvalApprovalReceipt('return "different"', approvalId)
        })
      )
    ).resolves.toBe(false)

    expect(order).not.toContain('registerGeminiTool')
    expect(order).not.toContain('runManager.registerApproval')
    expect(order).not.toContain('appendDurableRunEventForRoute')
    expect(order.filter((entry) => entry === 'safeSendToSender:agent-error')).toHaveLength(2)
  })
})

function makeMainDeps(order: string[]) {
  const deps = makeDeps(order)
  return {
    getApprovalService: deps.getApprovalService,
    runManager: deps.runManager,
    scheduleApprovalTimeout: deps.scheduleApprovalTimeout,
    appendDurableRunEventForRoute: deps.appendDurableRunEventForRoute,
    recordApprovalLedgerRequest: deps.recordApprovalLedgerRequest,
    safeSendToSender: deps.safeSendToSender,
    notifyPairedDevicesOfApproval: deps.notifyPairedDevicesOfApproval,
    workspaceIdForApprovalPush: deps.workspaceIdForApprovalPush
  }
}

function mainRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: 'workspace/session-trust',
    title: 'Approve workspace trust',
    body: 'trust body',
    runId: 'run-1',
    ...overrides
  } as never
}

const mainSender = { isDestroyed: () => false, send: vi.fn() } as never

describe('createMainApprovalOrchestration — security guard sequence', () => {
  // (m1) Missing sender should short-circuit without side effects.
  it('(m1) short-circuits when sender is absent or destroyed', async () => {
    const order: string[] = []
    const deps = makeMainDeps(order)

    expect(await createMainApprovalOrchestration(deps)(null, 'gemini', null, mainRequest())).toBe(false)
    expect(order).toEqual([])

    const destroyed = { isDestroyed: () => true, send: vi.fn() } as never
    expect(await createMainApprovalOrchestration(deps)(destroyed, 'gemini', null, mainRequest())).toBe(false)
    expect(order).toEqual([])
  })

  // (m2) The main-authority prompt must register live through getApprovalService
  // (REGISTER equivalent) so a stale by-value capture cannot no-op this path.
  it('(m2) opens a main-authority prompt with live getApprovalService()', async () => {
    const order: string[] = []
    const deps = makeMainDeps(order)

    createMainApprovalOrchestration(deps)(
      mainSender,
      'gemini',
      { appRunId: 'run-1', appChatId: 'chat-1' },
      mainRequest()
    )
    await Promise.resolve()

    expect(order).toEqual([
      'getApprovalService',
      'registerMain',
      'runManager.registerApproval',
      'scheduleApprovalTimeout',
      'appendDurableRunEventForRoute',
      'recordApprovalLedgerRequest',
      'safeSendToSender:agent-approval-request',
      'notifyPairedDevicesOfApproval'
    ])
    expect(deps.getApprovalService).toHaveBeenCalled()
  })

  // (m3) Null approval service cannot own the pending resolver, so fail closed
  // before creating a durable or visible approval that can never settle.
  it('(m3) a null approval service fails closed before emitting a main-authority prompt', async () => {
    const order: string[] = []
    const deps = makeMainDeps(order)
    vi.mocked(deps.getApprovalService).mockReturnValue(null as never)

    await expect(
      createMainApprovalOrchestration(deps)(mainSender, 'gemini', null, mainRequest())
    ).resolves.toBe(false)

    expect(order).not.toContain('runManager.registerApproval')
    expect(order).not.toContain('registerMain')
    expect(order).not.toContain('safeSendToSender:agent-approval-request')
    expect(order).not.toContain('notifyPairedDevicesOfApproval')
  })

  // (m4) The main-authority timeout and ledger metadata flags must be injected.
  it('(m4) preserves main-authority markers on timeout + ledger metadata', async () => {
    const order: string[] = []
    const deps = makeMainDeps(order)

    createMainApprovalOrchestration(deps)(mainSender, 'gemini', null, mainRequest())
    await Promise.resolve()

    expect(deps.scheduleApprovalTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: expect.any(String),
        provider: 'gemini',
        route: expect.objectContaining({
          appRunId: expect.any(String)
        }),
        isMainAuthority: true,
        kind: 'workspace/session-trust'
      })
    )
    const ledgerCalls = vi.mocked(deps.recordApprovalLedgerRequest).mock.calls
    expect(ledgerCalls[0][3]).toMatchObject({ metadata: { mainAuthority: true } })
  })

  // (m5) Route normalization should apply fallback run IDs when missing from route.
  it('(m5) normalizes route through routeWithRunId before building approval payload', async () => {
    const order: string[] = []
    const deps = makeMainDeps(order)

    createMainApprovalOrchestration(deps)(mainSender, 'gemini', null, mainRequest())
    await Promise.resolve()

    expect(vi.mocked(deps.runManager.registerApproval)).toHaveBeenCalledWith(expect.stringContaining('gemini-'), expect.any(String))
    expect(vi.mocked(deps.safeSendToSender)).toHaveBeenCalledWith(mainSender, 'agent-approval-request', expect.objectContaining({
      appRunId: expect.stringContaining('gemini-'),
      appChatId: undefined,
      title: 'Approve workspace trust',
      preview: expect.objectContaining({
        actions: ['accept', 'decline', 'cancel']
      })
    }))
  })

  // (m6) Paired-device fan-out should include workspace-derived thread and summary metadata.
  it('(m6) fans out paired-device approval metadata with workspace-derived thread id', async () => {
    const order: string[] = []
    const deps = makeMainDeps(order)
    vi.mocked(deps.workspaceIdForApprovalPush).mockReturnValue('ws-id')

    createMainApprovalOrchestration(deps)(mainSender, 'gemini', { appRunId: 'run-1', appChatId: 'chat-1' }, mainRequest())
    await Promise.resolve()

    const notifyCall = vi.mocked(deps.notifyPairedDevicesOfApproval).mock.calls[0]
    expect(notifyCall[0]).toMatchObject({
      approvalId: expect.any(String),
      workspaceId: 'ws-id',
      threadId: 'chat-1',
      summary: 'Approve workspace trust'
    })
  })
})

describe('createApprovalOrchestration — read-only git status shell fast path', () => {
  it('auto-allows a posture-denied `git status` AFTER resolve, with no prompt', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'deny', decision: 'deny' })

    const result = await createApprovalOrchestration(deps)(
      sender,
      'claude',
      'shellCommands',
      '/repo',
      request({ preview: { kind: 'command', command: 'git status --porcelain' } })
    )

    expect(result).toBe(true)
    // Ordering: the fast path consults the resolved policy first, then audits.
    expect(order).toEqual(['permissionService.resolvePermission', 'audit:autoAllow:readonly_shell'])
    expect(order).not.toContain('getApprovalService')
    expect(order).not.toContain('registerGeminiTool')
    const metadata = vi.mocked(deps.auditService.recordAutomaticApprovalDecision).mock.calls[0][8]
    expect(metadata).toMatchObject({ command: 'git status --porcelain' })
  })

  it('prefers the raw params command over a display string', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'deny', decision: 'deny' })

    const result = await createApprovalOrchestration(deps)(
      sender,
      'codex',
      'shellCommands',
      '/repo',
      request({
        preview: {
          kind: 'command',
          command: 'bash -lc git status',
          params: { command: ['bash', '-lc', 'git status'] }
        }
      })
    )

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:readonly_shell')
  })

  it('fails closed: anything beyond a pure git status still hits the deny path', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'deny', decision: 'deny' })

    const result = await createApprovalOrchestration(deps)(
      sender,
      'claude',
      'shellCommands',
      '/repo',
      request({ preview: { kind: 'command', command: 'git status && rm -rf /' } })
    )

    expect(result).toBe(false)
    expect(order).toContain('audit:autoDeny:policy')
    expect(order).not.toContain('audit:autoAllow:readonly_shell')
  })

  it('never fires for other services, forcePrompt, or command-less previews', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'deny', decision: 'deny' })

    // Same command string under a non-shell service → normal deny.
    expect(
      await createApprovalOrchestration(deps)(
        sender,
        'gemini',
        'mcpTools',
        '/repo',
        request({ preview: { kind: 'command', command: 'git status' } })
      )
    ).toBe(false)

    // forcePrompt demands human review even for git status (ask policy →
    // prompt). Fire-and-drain like case (h): the registered prompt never
    // resolves in this harness.
    const promptOrder: string[] = []
    const promptDeps = makeDeps(promptOrder)
    setResolution(promptDeps, promptOrder, { policy: 'ask', decision: 'ask' })
    void createApprovalOrchestration(promptDeps)(
      sender,
      'claude',
      'shellCommands',
      '/repo',
      request({ forcePrompt: true, preview: { kind: 'command', command: 'git status' } })
    )
    await Promise.resolve()
    expect(promptOrder).not.toContain('audit:autoAllow:readonly_shell')
    expect(promptOrder).toContain('registerGeminiTool')

    // No command in the preview → nothing to classify → normal deny.
    const bareOrder: string[] = []
    const bareDeps = makeDeps(bareOrder)
    setResolution(bareDeps, bareOrder, { policy: 'deny', decision: 'deny' })
    expect(
      await createApprovalOrchestration(bareDeps)(
        sender,
        'claude',
        'shellCommands',
        '/repo',
        request()
      )
    ).toBe(false)
  })

  it('skips an ask-policy prompt for git status but leaves policy-allow flows untouched', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'ask', decision: 'ask' })

    expect(
      await createApprovalOrchestration(deps)(
        sender,
        'gemini',
        'shellCommands',
        '/repo',
        request({ preview: { kind: 'command', command: 'git status -sb' } })
      )
    ).toBe(true)
    expect(order).toContain('audit:autoAllow:readonly_shell')

    // decision 'allow' keeps the ordinary audited auto-allow (reason: policy).
    const allowOrder: string[] = []
    const allowDeps = makeDeps(allowOrder)
    setResolution(allowDeps, allowOrder, { policy: 'allow', decision: 'allow' })
    expect(
      await createApprovalOrchestration(allowDeps)(
        sender,
        'gemini',
        'shellCommands',
        '/repo',
        request({ preview: { kind: 'command', command: 'git status' } })
      )
    ).toBe(true)
    expect(allowOrder).toContain('audit:autoAllow:policy')
    expect(allowOrder).not.toContain('audit:autoAllow:readonly_shell')
  })
})
