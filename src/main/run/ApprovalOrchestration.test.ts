// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createApprovalOrchestration,
  type RequestAgenticServiceApprovalDeps
} from './ApprovalOrchestration'

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
  isPlanInstrumentGrantHold: vi.fn(() => false)
}))

import { effectiveAgenticSettings } from '../NativeApprovalPolicy'
import { approvalActionsForPolicy } from '../AgenticServiceMessages'
import { isPlanInstrumentGrantHold } from '../EffectiveRunPermissions'

type Resolution = {
  policy: string
  workspaceGrantAllowed: boolean
  sessionGrantAllowed: boolean
  decision: string
}

function makeDeps(order: string[]): RequestAgenticServiceApprovalDeps {
  return {
    runManager: {
      get: vi.fn(() => undefined),
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

  // (g2) REGISTER null-service — a null approval service (pre-init) must not throw;
  // the optional-chain skips registerGeminiTool but the rest of the sequence runs.
  it('(g2) a null approval service skips registerGeminiTool without throwing', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.getApprovalService).mockReturnValue(null as never)

    createApprovalOrchestration(deps)(sender, 'gemini', 'mcpTools', '/repo', request())
    await Promise.resolve()

    expect(vi.mocked(deps.getApprovalService)).toHaveBeenCalled() // live read still happens
    expect(order).not.toContain('registerGeminiTool') // null → optional-chain no-op
    expect(order).toContain('runManager.registerApproval') // sequence continues
    expect(order).toContain('safeSendToSender:agent-approval-request')
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

    createApprovalOrchestration(deps)(sender, 'claude', 'canvasEval', '/repo', request())
    await Promise.resolve()

    // no auto-allow of any flavour…
    expect(order).not.toContain('audit:autoAllow:session_yolo')
    expect(order).not.toContain('audit:autoAllow:workspace_grant')
    expect(order).not.toContain('audit:autoAllow:bossman_auto')
    // …it reaches the human prompt instead.
    expect(order).toContain('registerGeminiTool')
  })
})
