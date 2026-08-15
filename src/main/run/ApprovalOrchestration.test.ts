// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createApprovalOrchestration,
  createMainApprovalOrchestration,
  type RequestAgenticServiceApprovalDeps
} from './ApprovalOrchestration'
import { redactCanvasFillValueForDurableStorage } from '../canvas/CanvasFillAudit'
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
    vi.mocked(deps.networkAccessBlockedToolName).mockImplementation(
      (toolName, _permissions, toolArgs) =>
        toolName === 'browser_open' &&
        (toolArgs as { url?: string } | undefined)?.url === 'https://example.com'
          ? 'browser_open'
          : null
    )

    const result = await createApprovalOrchestration(deps)(
      sender,
      'gemini',
      'mcpTools',
      '/repo',
      request({
        preview: {
          toolName: 'browser_open',
          params: { url: 'https://example.com', show: true }
        }
      })
    )

    expect(result).toBe(false)
    expect(deps.networkAccessBlockedToolName).toHaveBeenCalledWith('browser_open', undefined, {
      url: 'https://example.com',
      show: true
    })
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

    const result = await createApprovalOrchestration(deps)(
      sender,
      'gemini',
      'mcpTools',
      '/repo',
      request()
    )

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

    const result = await createApprovalOrchestration(deps)(
      sender,
      'gemini',
      'mcpTools',
      '/repo',
      request()
    )

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

    const result = await createApprovalOrchestration(deps)(
      sender,
      'codex',
      'mcpTools',
      '/repo',
      request()
    )

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:workspace_grant')
    expect(order).not.toContain('registerGeminiTool')
  })

  it('(e2) auto-allows an external write only when the active Full Access scope confirms it', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'allow', decision: 'allow' })
    vi.mocked(deps.canAutoApproveTrustedSessionExternalWrite).mockReturnValue(true)

    const result = await createApprovalOrchestration(deps)(
      sender,
      'claude',
      'fileChanges',
      '/repo',
      request({
        externalPathDetection: { provider: 'claude', path: '/tmp/output.txt', access: 'write' }
      })
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

    const result = await createApprovalOrchestration(deps)(
      sender,
      'claude',
      'mcpTools',
      '/repo',
      request()
    )

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

    const promise = createApprovalOrchestration(deps)(
      sender,
      'gemini',
      'mcpTools',
      '/repo',
      request()
    )
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

  it('(g1) passes the signed effective preset into Ensemble approval attribution', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    const ensembleRun = {
      roundId: 'round-1',
      participantId: 'participant-2',
      laneId: 'lane-2',
      provider: 'antigravity',
      role: 'Scout2',
      order: 5
    }
    vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
      runId
        ? {
            runId,
            appChatId: 'chat-1',
            status: 'running',
            state: {
              appChatId: 'chat-1',
              ensembleRun,
              effectivePermissions: { presetId: 'read_only' }
            }
          }
        : undefined) as never)

    const promise = createApprovalOrchestration(deps)(
      sender,
      'antigravity',
      'mcpTools',
      '/repo',
      request()
    )
    await Promise.resolve()

    expect(deps.ensembleApprovalContext).toHaveBeenCalledWith(
      ensembleRun,
      'mcpTools',
      '/repo',
      'read_only'
    )
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

  // (h3) NEVER-AUTO-ALLOW — Isolate pinned-Shared branch hold. An ensemble
  // seat's `git checkout -b` under a chat whose Isolate policy pins the
  // shared checkout must PROMPT even with session-YOLO + an allow decision:
  // the chat-scoped Isolate setting is user authority no posture, grant, or
  // YOLO may bypass (ask-hold, not deny — unattended lanes fail safe via the
  // approval timeout).
  it('(h3) Isolate pinned-Shared holds seat branch creation despite YOLO + allow', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.isSessionYoloEffective).mockReturnValue(true)
    setResolution(deps, order, { policy: 'allow', decision: 'allow' })
    vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
      runId
        ? {
            runId,
            appChatId: 'chat-1',
            status: 'running',
            state: {
              appChatId: 'chat-1',
              ensembleRun: { provider: 'codex', role: 'Builder', roundId: 'round-1' }
            }
          }
        : undefined) as never)
    // Chat with ensemble config and NO fanoutIsolation set — undefined pins
    // Shared (the enforced default).
    deps.getChatById = vi.fn(() => ({ ensemble: { enabled: true, participants: [] } }) as never)

    createApprovalOrchestration(deps)(
      sender,
      'codex',
      'shellCommands',
      '/repo',
      request({
        preview: {
          command: 'git checkout -b feature/x',
          params: { command: 'git checkout -b feature/x' }
        }
      })
    )
    await Promise.resolve()

    expect(order).not.toContain('audit:autoAllow:session_yolo')
    expect(order).not.toContain('audit:autoAllow:workspace_grant')
    expect(order).toContain('registerGeminiTool')
  })

  // (h4) …and the SAME command auto-allows again when the chat's Isolate
  // policy is Any (agent-decided) — the hold is policy-scoped, not a blanket
  // git restriction.
  it('(h4) the same seat branch creation auto-allows when Isolate policy is Any', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.isSessionYoloEffective).mockReturnValue(true)
    setResolution(deps, order, { policy: 'allow', decision: 'allow' })
    vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
      runId
        ? {
            runId,
            appChatId: 'chat-1',
            status: 'running',
            state: {
              appChatId: 'chat-1',
              ensembleRun: { provider: 'codex', role: 'Builder', roundId: 'round-1' }
            }
          }
        : undefined) as never)
    deps.getChatById = vi.fn(
      () => ({ ensemble: { enabled: true, participants: [], fanoutIsolation: 'any' } }) as never
    )

    const result = await createApprovalOrchestration(deps)(
      sender,
      'codex',
      'shellCommands',
      '/repo',
      request({
        preview: {
          command: 'git checkout -b feature/x',
          params: { command: 'git checkout -b feature/x' }
        }
      })
    )

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:session_yolo')
    expect(order).not.toContain('registerGeminiTool')
  })

  // (d1) TIER HOLD — catastrophic deletion at Full WS Access. Owner spec
  // (slices D/E): `rm -r` class ALWAYS asks at workspace_write, surviving
  // session-YOLO and an allow decision. Ask-hold, not deny.
  it('(d1) recursive rm at workspace_write prompts despite YOLO + allow', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.isSessionYoloEffective).mockReturnValue(true)
    setResolution(deps, order, { policy: 'allow', decision: 'allow' })
    vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
      runId
        ? {
            runId,
            appChatId: 'chat-1',
            status: 'running',
            state: {
              appChatId: 'chat-1',
              effectivePermissions: { presetId: 'workspace_write' }
            }
          }
        : undefined) as never)

    createApprovalOrchestration(deps)(
      sender,
      'codex',
      'shellCommands',
      '/repo',
      request({
        preview: {
          command: 'rm -rf node_modules',
          params: { command: 'rm -rf node_modules' }
        }
      })
    )
    await Promise.resolve()

    expect(order).not.toContain('audit:autoAllow:session_yolo')
    expect(order).toContain('registerGeminiTool')
  })

  // (d2) TIER HOLD — remote egress asks even at Full Access (owner spec:
  // remote/SSH + raw network shell commands ASK at both write tiers).
  it('(d2) ssh at full_access prompts despite YOLO + allow', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.isSessionYoloEffective).mockReturnValue(true)
    setResolution(deps, order, { policy: 'allow', decision: 'allow' })
    vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
      runId
        ? {
            runId,
            appChatId: 'chat-1',
            status: 'running',
            state: {
              appChatId: 'chat-1',
              effectivePermissions: { presetId: 'full_access' }
            }
          }
        : undefined) as never)

    createApprovalOrchestration(deps)(
      sender,
      'codex',
      'shellCommands',
      '/repo',
      request({
        preview: {
          command: 'ssh host uptime',
          params: { command: 'ssh host uptime' }
        }
      })
    )
    await Promise.resolve()

    expect(order).not.toContain('audit:autoAllow:session_yolo')
    expect(order).toContain('registerGeminiTool')
  })

  // (d3) INSPECTION FAST PATH — read-only inspection commands (`ls`, `cat`,
  // `grep`…) run prompt-free under an ask policy, the shell twins of the
  // auto-allowed MCP read tools (mirrors the read-only git fast path).
  it('(d3) ls auto-allows under an ask policy via the inspection fast path', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'ask', decision: 'ask' })

    const result = await createApprovalOrchestration(deps)(
      sender,
      'codex',
      'shellCommands',
      '/repo',
      request({
        preview: {
          command: 'ls -la src',
          params: { command: 'ls -la src' }
        }
      })
    )

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:inspection_shell')
    expect(order).not.toContain('registerGeminiTool')
  })

  it('(d3) auto-allows quoted grep, git grep, and constrained sed inspection', async () => {
    for (const command of [
      'grep -i "canvas" src/',
      'git grep -n -C 5 "isCanvasDockPanelOpen" src/renderer/src/App.tsx',
      "sed -n '401,600p' src/renderer/src/components/CanvasDockPanel.tsx"
    ]) {
      const order: string[] = []
      const deps = makeDeps(order)
      setResolution(deps, order, { policy: 'ask', decision: 'ask' })

      await expect(
        createApprovalOrchestration(deps)(
          sender,
          'antigravity',
          'shellCommands',
          '/repo',
          request({ preview: { command, params: { command } } })
        )
      ).resolves.toBe(true)
      expect(order).toContain('audit:autoAllow:inspection_shell')
      expect(order).not.toContain('registerGeminiTool')
    }
  })

  it('(d3) auto-allows safe find, null redirects, and read-only sequences for scouts', async () => {
    for (const command of [
      "find . -maxdepth 1 -type f \\( -name '.WORK-IN-PROGRESS-*' -o -name 'SHIP-HOLD*' \\) -print",
      'find .local-only -maxdepth 4 -type f -print 2>/dev/null',
      "ls -l /opt/homebrew/bin 2>/dev/null\nfind /opt/homebrew/Cellar -maxdepth 2 -iname 'rust*' -print 2>/dev/null",
      'ls -la && git status --short'
    ]) {
      const order: string[] = []
      const deps = makeDeps(order)
      setResolution(deps, order, { policy: 'ask', decision: 'ask' })

      await expect(
        createApprovalOrchestration(deps)(
          sender,
          'codex',
          'shellCommands',
          '/repo',
          request({ preview: { command, params: { command } } })
        )
      ).resolves.toBe(true)
      expect(order).toContain('audit:autoAllow:inspection_shell')
      expect(order).not.toContain('registerGeminiTool')
    }
  })

  it('(d3) keeps destructive find and mixed mutations on the normal permission path', async () => {
    for (const command of [
      'find . -delete',
      'find . -exec touch {} +',
      'find . -type f > inventory.txt',
      'ls -la && rm -rf build'
    ]) {
      const order: string[] = []
      const deps = makeDeps(order)
      setResolution(deps, order, { policy: 'deny', decision: 'deny' })

      await expect(
        createApprovalOrchestration(deps)(
          sender,
          'codex',
          'shellCommands',
          '/repo',
          request({ preview: { command, params: { command } } })
        )
      ).resolves.toBe(false)
      expect(order).toContain('audit:autoDeny:policy')
      expect(order).not.toContain('audit:autoAllow:inspection_shell')
    }
  })

  // (d4) FULL ACCESS IN-WORKSPACE DELETE — "always approve in workspace":
  // a provably in-workspace recursive rm keeps auto-allowing at full_access.
  it('(d4) provably in-workspace rm -rf auto-allows at full_access', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(deps.isSessionYoloEffective).mockReturnValue(true)
    setResolution(deps, order, { policy: 'allow', decision: 'allow' })
    vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
      runId
        ? {
            runId,
            appChatId: 'chat-1',
            status: 'running',
            state: {
              appChatId: 'chat-1',
              effectivePermissions: { presetId: 'full_access' }
            }
          }
        : undefined) as never)

    const result = await createApprovalOrchestration(deps)(
      sender,
      'codex',
      'shellCommands',
      '/repo',
      request({
        preview: {
          command: 'rm -rf build',
          params: { command: 'rm -rf build' }
        }
      })
    )

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:session_yolo')
    expect(order).not.toContain('registerGeminiTool')
  })

  // (d5) EXTERNAL READ SPLIT — outside-workspace READS auto-approve at the
  // write tiers (owner spec: Full WS Access "auto-approve all reads outside
  // workspace unprompted"); writes keep the external-path card.
  it('(d5) an external READ detection auto-allows at workspace_write', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'ask', decision: 'ask' })
    vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
      runId
        ? {
            runId,
            appChatId: 'chat-1',
            status: 'running',
            state: {
              appChatId: 'chat-1',
              effectivePermissions: { presetId: 'workspace_write' }
            }
          }
        : undefined) as never)

    const result = await createApprovalOrchestration(deps)(
      sender,
      'codex',
      'fileChanges',
      '/repo',
      request({
        externalPathDetection: {
          provider: 'codex',
          path: '/outside/readme.txt',
          access: 'read'
        }
      })
    )

    expect(result).toBe(true)
    expect(order).toContain('audit:autoAllow:external_read')
    expect(order).not.toContain('registerGeminiTool')
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

  it('(h3) Plan mesh edits remain per-call request-only despite an allow decision', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(isPlanInstrumentGrantHold).mockImplementation(
      (presetId, service) => presetId === 'plan' && service === 'meshCanvas'
    )
    vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
      runId
        ? {
            runId,
            appChatId: 'chat-1',
            status: 'running',
            state: { effectivePermissions: { presetId: 'plan' } }
          }
        : undefined) as never)
    vi.mocked(deps.permissionService.resolvePermission).mockReturnValue({
      policy: 'allow',
      workspaceGrantAllowed: true,
      sessionGrantAllowed: true,
      decision: 'allow'
    })

    const pending = createApprovalOrchestration(deps)(
      sender,
      'codex',
      'meshCanvas',
      '/repo',
      request({ preview: { kind: 'tool', toolName: 'mesh_topology_edit' } })
    )
    await Promise.resolve()

    expect(order).not.toContain('audit:autoAllow:policy')
    expect(order).toContain('registerGeminiTool')
    const livePayload = vi.mocked(deps.safeSendToSender).mock.calls[0]?.[2] as any
    expect(livePayload.actions).toEqual(['accept', 'decline', 'cancel'])
    expect(livePayload.preview).toMatchObject({
      requestOnly: true,
      requestOnlyReason:
        'This approval is per-call only; session/workspace grants are disabled for this request.'
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
    const durableRunPayload = vi.mocked(deps.appendDurableRunEventForRoute).mock
      .calls[0]?.[5] as any
    const durableLedgerPayload = vi.mocked(deps.recordApprovalLedgerRequest).mock
      .calls[0]?.[2] as any

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

  it('(i1) carries the target surface into BOTH the grant check and the pending record', async () => {
    // The canvasId used to be lost between request and response: the pending
    // record kept provider/service/workspace/runId only, so an "allow for
    // session" could only ever be minted unscoped — i.e. meaning every canvas.
    // Both ends have to see the surface for a scoped grant to exist at all.
    const order: string[] = []
    const deps = makeDeps(order)
    // getApprovalService returns a fresh object per call, so pin a stable spy to
    // observe what the pending record is actually registered with.
    const registerGeminiTool = vi.fn((_approvalId: string, _info: Record<string, unknown>) => {
      order.push('registerGeminiTool')
    })
    deps.getApprovalService = vi.fn(() => ({
      registerGeminiTool,
      registerMain: vi.fn()
    })) as never

    const pending = createApprovalOrchestration(deps)(
      sender,
      'claude',
      'canvasInteraction',
      '/repo',
      request({
        preview: {
          kind: 'tool',
          toolName: 'canvas_click',
          params: { canvasId: 'canvas-the-user-approved', ref: 'e1' }
        }
      })
    )
    await Promise.resolve()

    // Request side: the grant lookup is scoped, so a grant held for another
    // canvas cannot satisfy this one.
    expect(vi.mocked(deps.permissionService.resolvePermission).mock.calls[0]?.[5]).toBe(
      'canvas-the-user-approved'
    )
    // Response side: the id survives to where the grant is written.
    expect(registerGeminiTool.mock.calls[0]?.[1]).toMatchObject({
      surfaceId: 'canvas-the-user-approved'
    })
    void pending
  })

  it('(i2) keeps canvas_fill typed values transient — the durable sinks never retain them', async () => {
    // The canvas preview passes the tool's raw args through as preview.params so
    // the human can see what is about to be typed. That payload is ALSO written
    // to the durable run-event store and the approval ledger, so the typed value
    // was retained indefinitely — while the catalogue told models it is never
    // recorded. Same live-vs-durable split canvas_eval uses.
    const order: string[] = []
    const deps = makeDeps(order)
    const typed = 'TYPED-SECRET-VALUE'

    const pending = createApprovalOrchestration(deps)(
      sender,
      'claude',
      'canvasInteraction',
      '/repo',
      request({
        preview: {
          kind: 'tool',
          toolName: 'canvas_fill',
          params: { canvasId: 'canvas-1', ref: 'e2', value: typed }
        }
      })
    )
    await Promise.resolve()

    const livePayload = vi.mocked(deps.safeSendToSender).mock.calls[0]?.[2] as any
    const durableRunPayload = vi.mocked(deps.appendDurableRunEventForRoute).mock
      .calls[0]?.[5] as any
    const durableLedgerPayload = vi.mocked(deps.recordApprovalLedgerRequest).mock
      .calls[0]?.[2] as any

    // The human still sees exactly what will be typed.
    expect(livePayload.preview.params.value).toBe(typed)
    // Nothing durable retains it.
    expect(JSON.stringify(durableRunPayload)).not.toContain(typed)
    expect(JSON.stringify(durableLedgerPayload)).not.toContain(typed)
    // The key survives so a reader can still tell a value was supplied.
    expect(durableRunPayload.preview.params.value).toBe('[redacted]')
    expect(durableRunPayload.preview.params.valueRedacted).toBe(true)
    // Non-secret targeting metadata is untouched — this is a value redaction,
    // not a blanket scrub that would gut the audit trail.
    expect(durableRunPayload.preview.params.ref).toBe('e2')
    expect(durableRunPayload.preview.params.canvasId).toBe('canvas-1')
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

    expect(await createMainApprovalOrchestration(deps)(null, 'gemini', null, mainRequest())).toBe(
      false
    )
    expect(order).toEqual([])

    const destroyed = { isDestroyed: () => true, send: vi.fn() } as never
    expect(
      await createMainApprovalOrchestration(deps)(destroyed, 'gemini', null, mainRequest())
    ).toBe(false)
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

  // (m2a2) Ensemble seat attribution. The service orchestration has carried
  // the requesting participant since AR3, but the MAIN authority path (tool
  // permission retries, session trust, host reruns) never looked the session
  // up — so a multi-seat ensemble showed "Allow Pi to retry write_file once?"
  // with no way to tell WHICH Pi seat was asking. The title gains the seat
  // role and the preview gains the bounded identity the renderer's
  // attribution section already knows how to show.
  it('(m2a2) attributes a main approval to the requesting ensemble seat', async () => {
    const order: string[] = []
    const sent: Array<Record<string, unknown>> = []
    const registered: Array<Record<string, unknown>> = []
    const deps = {
      ...makeMainDeps(order),
      runManager: {
        get: vi.fn((runId: string) =>
          runId === 'run-1'
            ? {
                runId: 'run-1',
                appChatId: 'chat-1',
                state: {
                  ensembleRun: {
                    roundId: 'round-1',
                    participantId: 'ensemble-participant-14',
                    provider: 'pi',
                    role: 'K3Review',
                    stageRole: 'reviewer',
                    order: 3
                  }
                }
              }
            : undefined
        ),
        registerApproval: vi.fn(() => order.push('runManager.registerApproval'))
      },
      getApprovalService: vi.fn(() => ({
        registerMain: vi.fn((_id: string, info: Record<string, unknown>) => {
          registered.push(info)
          return true
        })
      })),
      safeSendToSender: vi.fn((_sender: unknown, _channel: string, payload: unknown) => {
        sent.push(payload as Record<string, unknown>)
      })
    } as never
    createMainApprovalOrchestration(deps)(
      mainSender,
      'pi',
      { appRunId: 'run-1', appChatId: 'chat-1' },
      mainRequest({ title: 'Allow Pi to retry write_file once?' })
    )
    await Promise.resolve()

    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('K3Review: Allow Pi to retry write_file once?')
    expect(registered[0].title).toBe('K3Review: Allow Pi to retry write_file once?')
    expect((sent[0].preview as Record<string, unknown>).ensembleParticipant).toEqual({
      participantId: 'ensemble-participant-14',
      role: 'K3Review',
      stageRole: 'reviewer',
      // Seat number for the renderer's "@Role #N" chip — EnsembleRunIdentity
      // carries `order` (required), so the main path forwards it like the
      // service gate already does.
      order: 3
    })
  })

  // (m2a3) Solo runs stay untouched — no session, no ensemble identity, no
  // misleading label.
  it('(m2a3) leaves solo main approvals unattributed', async () => {
    const order: string[] = []
    const sent: Array<Record<string, unknown>> = []
    const deps = {
      ...makeMainDeps(order),
      safeSendToSender: vi.fn((_sender: unknown, _channel: string, payload: unknown) => {
        sent.push(payload as Record<string, unknown>)
      })
    } as never
    createMainApprovalOrchestration(deps)(
      mainSender,
      'pi',
      { appRunId: 'run-1', appChatId: 'chat-1' },
      mainRequest({ title: 'Allow Pi to retry write_file once?' })
    )
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('Allow Pi to retry write_file once?')
    expect((sent[0].preview as Record<string, unknown>).ensembleParticipant).toBeUndefined()
  })

  // (m2b) The registration must carry the request's own title/body. They were
  // silently dropped here for months: the desktop modal reads them from the
  // IPC payload instead, so only PAIRED DEVICES saw the fallback — an
  // "Approval requested" card offering Allow for text the phone never got.
  it('(m2b) registers the pending main approval WITH the request title and body', async () => {
    const order: string[] = []
    const deps = makeMainDeps(order)
    const registerMain = vi.fn((_approvalId: string, _info: Record<string, unknown>) => {
      order.push('registerMain')
      return true
    })
    deps.getApprovalService = vi.fn(() => ({
      registerGeminiTool: vi.fn(),
      registerMain
    })) as never

    createMainApprovalOrchestration(deps)(
      mainSender,
      'gemini',
      { appRunId: 'run-1', appChatId: 'chat-1' },
      mainRequest({ title: 'Route sub-agent natively?', body: 'claude wants a native sub-agent.' })
    )
    await Promise.resolve()

    expect(registerMain.mock.calls[0]?.[1]).toMatchObject({
      title: 'Route sub-agent natively?',
      body: 'claude wants a native sub-agent.'
    })
  })

  it('(m2c) keeps exact retry detail live while redacting durable canvas_fill values', async () => {
    const order: string[] = []
    const deps = makeMainDeps(order)
    const secret = '__CANVAS_FILL_RETRY_SECRET__'
    const registerMain = vi.fn((_approvalId: string, _info: Record<string, unknown>) => {
      order.push('registerMain')
      return true
    })
    deps.getApprovalService = vi.fn(() => ({
      registerGeminiTool: vi.fn(),
      registerMain
    })) as never

    createMainApprovalOrchestration(deps)(
      mainSender,
      'codex',
      { appRunId: 'run-1', appChatId: 'chat-1' },
      mainRequest({
        method: 'toolPermissionRetry',
        remoteIncomplete: true,
        preview: {
          toolName: 'canvas_fill',
          params: { canvasId: 'canvas-1', ref: 'field-1', value: secret },
          permissionRetry: {
            targetArgumentsSha256: 'a'.repeat(64),
            exactArguments: { canvasId: 'canvas-1', ref: 'field-1', value: secret }
          }
        }
      })
    )
    await Promise.resolve()

    expect(registerMain.mock.calls[0]?.[1]).toMatchObject({ remoteIncomplete: true })
    const durableEventPayload = vi.mocked(deps.appendDurableRunEventForRoute).mock.calls[0]?.[5]
    const durableLedgerPayload = vi.mocked(deps.recordApprovalLedgerRequest).mock.calls[0]?.[2]
    const livePayload = vi.mocked(deps.safeSendToSender).mock.calls[0]?.[2]
    expect(JSON.stringify(durableEventPayload)).not.toContain(secret)
    expect(JSON.stringify(durableLedgerPayload)).not.toContain(secret)
    expect(JSON.stringify(durableEventPayload)).toContain('[redacted]')
    expect(JSON.stringify(durableEventPayload)).toContain('exactArgumentsRedacted')
    expect(JSON.stringify(livePayload)).toContain(secret)
  })

  it('(m2d) redacts nested retry values and their dictionary-testable fingerprint', () => {
    const secret = '__NESTED_CANVAS_FILL_SECRET__'
    const durable = redactCanvasFillValueForDurableStorage({
      permissionRetry: {
        targetArgumentsSha256: 'b'.repeat(64),
        arguments: {
          name: 'request_tool_permission',
          arguments: {
            toolName: 'mcp__TaskWraith__canvas_fill',
            arguments: { canvasId: 'canvas-1', ref: 'field-1', value: secret }
          }
        }
      }
    })
    expect(JSON.stringify(durable)).not.toContain(secret)
    expect(durable.permissionRetry.targetArgumentsSha256).toBeUndefined()
    expect(durable.permissionRetry).toMatchObject({
      targetArgumentsFingerprintRedacted: true
    })
    expect(durable.permissionRetry.arguments.arguments.arguments).toMatchObject({
      canvasId: 'canvas-1',
      ref: 'field-1',
      value: '[redacted]',
      valueRedacted: true
    })
  })

  it('(m2e) redacts JSON-encoded native canvas_fill arguments under prefixed identities', () => {
    const secret = '__STRINGIFIED_CANVAS_FILL_SECRET__'
    const durable = redactCanvasFillValueForDurableStorage({
      toolName: 'mcp__TaskWraith__canvas_fill',
      arguments: JSON.stringify({ canvasId: 'canvas-1', ref: 'field-1', value: secret })
    })

    expect(JSON.stringify(durable)).not.toContain(secret)
    const durableRecord = durable as Record<string, unknown>
    expect(durableRecord.argumentsRedacted).toBe(true)
    expect(JSON.parse(String(durableRecord.arguments))).toMatchObject({
      canvasId: 'canvas-1',
      ref: 'field-1',
      value: '[redacted]',
      valueRedacted: true
    })
  })

  it('(m2f) detects a fill target inside a stringified retry envelope', () => {
    const secret = '__STRINGIFIED_RETRY_CANVAS_FILL_SECRET__'
    const durable = redactCanvasFillValueForDurableStorage({
      toolName: 'capability_invoke',
      params: JSON.stringify({
        name: 'request_tool_permission',
        arguments: {
          toolName: 'canvas_fill',
          arguments: { canvasId: 'canvas-1', ref: 'field-1', value: secret },
          failure: `permission denied while typing ${secret}`,
          rationale: secret
        }
      })
    })

    expect(JSON.stringify(durable)).not.toContain(secret)
    const durableRecord = durable as Record<string, unknown>
    expect(durableRecord.paramsRedacted).toBe(true)
    expect(JSON.parse(String(durableRecord.params))).toMatchObject({
      name: 'request_tool_permission',
      arguments: {
        toolName: 'canvas_fill',
        arguments: { value: '[redacted]', valueRedacted: true },
        failure: '[redacted canvas_fill narrative]',
        failureRedacted: true,
        rationale: '[redacted canvas_fill narrative]',
        rationaleRedacted: true
      }
    })
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

    expect(vi.mocked(deps.runManager.registerApproval)).toHaveBeenCalledWith(
      expect.stringContaining('gemini-'),
      expect.any(String)
    )
    expect(vi.mocked(deps.safeSendToSender)).toHaveBeenCalledWith(
      mainSender,
      'agent-approval-request',
      expect.objectContaining({
        appRunId: expect.stringContaining('gemini-'),
        appChatId: undefined,
        title: 'Approve workspace trust',
        preview: expect.objectContaining({
          actions: ['accept', 'decline', 'cancel']
        })
      })
    )
  })

  // (m6) Paired-device fan-out should include workspace-derived thread and summary metadata.
  it('(m6) fans out paired-device approval metadata with workspace-derived thread id', async () => {
    const order: string[] = []
    const deps = makeMainDeps(order)
    vi.mocked(deps.workspaceIdForApprovalPush).mockReturnValue('ws-id')

    createMainApprovalOrchestration(deps)(
      mainSender,
      'gemini',
      { appRunId: 'run-1', appChatId: 'chat-1' },
      mainRequest()
    )
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

  it('extends to pure git diff / git log invocations', async () => {
    for (const command of ['git diff --stat', 'git log --oneline -20']) {
      const order: string[] = []
      const deps = makeDeps(order)
      setResolution(deps, order, { policy: 'deny', decision: 'deny' })
      expect(
        await createApprovalOrchestration(deps)(
          sender,
          'claude',
          'shellCommands',
          '/repo',
          request({ preview: { kind: 'command', command } })
        )
      ).toBe(true)
      expect(order).toContain('audit:autoAllow:readonly_shell')
    }
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

describe('createApprovalOrchestration — AntiGravity shell approval parity', () => {
  const screenshotCommands: Array<{ command: string; reason: string }> = [
    { command: 'git diff --check', reason: 'readonly_shell' },
    {
      command: 'git rev-parse HEAD && git status --porcelain',
      reason: 'inspection_shell'
    },
    {
      command: 'git log -n 5 --oneline && git rev-list --count origin/master..master',
      reason: 'inspection_shell'
    },
    {
      command: 'git grep -n "toolbar" swift/ || git grep -n "StudioOverlay" swift/',
      reason: 'inspection_shell'
    },
    {
      command:
        'git -c core.fsmonitor=false grep -i "effectpreview" src/main/ipc/ src/preload/ src/renderer/ || echo "NO_MATCHES"',
      reason: 'inspection_shell'
    },
    {
      command:
        "nl -ba src/main/collaboration/ChannelExternalSeatAuthority.test.ts | sed -n '241,360p'",
      reason: 'inspection_shell'
    },
    {
      command:
        'grep -rnE "(HumanCollaboration|humanCollaboration|human-collaboration|getHumanCollaborationRuntime|HumanCollaborationStore)" src/ --exclude-dir=node_modules | cut -d: -f1 | sort -u',
      reason: 'inspection_shell'
    },
    { command: 'npm run work-guard', reason: 'explicit_user_request' },
    {
      command: 'export PATH=$PATH:/opt/homebrew/bin; npm run work-guard',
      reason: 'explicit_user_request'
    },
    {
      command:
        'export PATH=$PATH:/usr/local/bin:/opt/homebrew/bin:~/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin; which npm node swift',
      reason: 'explicit_user_request'
    },
    {
      command: `export PATH=$PATH:/opt/homebrew/bin; node -e "const p = require('./package.json'); console.log(JSON.stringify(p.scripts, null, 2));"`,
      reason: 'explicit_user_request'
    }
  ]

  it('auto-allows every screenshot command even when the run posture resolves shell to deny', async () => {
    for (const { command, reason } of screenshotCommands) {
      const order: string[] = []
      const deps = makeDeps(order)
      setResolution(deps, order, { policy: 'deny', decision: 'deny' })

      await expect(
        createApprovalOrchestration(deps)(
          sender,
          'antigravity',
          'shellCommands',
          '/repo',
          request({ preview: { command, params: { command } } })
        )
      ).resolves.toBe(true)
      expect(order).toContain(`audit:autoAllow:${reason}`)
      expect(order).not.toContain('registerGeminiTool')
    }
  })

  it('does not grant AntiGravity exact-command exceptions to another provider', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'deny', decision: 'deny' })

    await expect(
      createApprovalOrchestration(deps)(
        sender,
        'claude',
        'shellCommands',
        '/repo',
        request({
          preview: {
            command: 'npm run work-guard',
            params: { command: 'npm run work-guard' }
          }
        })
      )
    ).resolves.toBe(false)
    expect(order).toContain('audit:autoDeny:policy')
    expect(order).not.toContain('audit:autoAllow:explicit_user_request')
  })

  it('auto-allows ordinary AntiGravity commands when Accept Edits resolves shell to allow', async () => {
    for (const command of [
      'npx vitest run src/main/collaboration/ChannelExternalSeatAuthority.test.ts',
      'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -n 1)/bin:$PATH" && which node && which npm',
      'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run src/main/collaboration/ChannelExternalSeatAuthority.test.ts'
    ]) {
      const order: string[] = []
      const deps = makeDeps(order)
      setResolution(deps, order, { policy: 'allow', decision: 'allow' })
      vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
        runId
          ? {
              runId,
              appChatId: 'chat-1',
              status: 'running',
              state: {
                effectivePermissions: { presetId: 'default', readOnly: false }
              }
            }
          : undefined) as never)

      await expect(
        createApprovalOrchestration(deps)(
          sender,
          'antigravity',
          'shellCommands',
          '/repo',
          request({ preview: { command, params: { command } } })
        )
      ).resolves.toBe(true)
      expect(order).toContain('audit:autoAllow:policy')
      expect(order).not.toContain('registerGeminiTool')
    }
  })

  it('keeps external publication attended at Accept Edits', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    setResolution(deps, order, { policy: 'ask', decision: 'ask' })
    vi.mocked(deps.runManager.get).mockImplementation(((runId?: string) =>
      runId
        ? {
            runId,
            appChatId: 'chat-1',
            status: 'running',
            state: {
              effectivePermissions: { presetId: 'default', readOnly: false }
            }
          }
        : undefined) as never)

    void createApprovalOrchestration(deps)(
      sender,
      'antigravity',
      'externalPublish',
      '/repo',
      request({
        preview: {
          command: 'git push origin master',
          params: { command: 'git push origin master' }
        }
      })
    )
    await Promise.resolve()

    expect(order).not.toContain('audit:autoAllow:policy')
    expect(order).toContain('registerGeminiTool')
  })
})
