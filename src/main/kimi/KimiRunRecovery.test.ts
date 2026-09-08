import { describe, expect, it, vi } from 'vitest'
import type { AcpPermissionRequest } from '../acp/AcpProtocol'
import { createKimiGatewayReadiness } from './KimiGatewayReadiness'
import type { KimiHttpMcpBridgeHandle } from './KimiHttpMcpBridge'
import { createKimiRunRecovery } from './KimiRunRecovery'
import type { KimiRunCapabilityReceipt } from './KimiRunCapabilities'
import type { KimiProviderToolSnapshot } from './KimiProviderToolSnapshot'

function fixture(
  toolSnapshot?: KimiProviderToolSnapshot,
  readToolSnapshot?: () => Promise<KimiProviderToolSnapshot | null>
) {
  const readiness = createKimiGatewayReadiness()
  const receipts: KimiRunCapabilityReceipt[] = []
  const recovery = createKimiRunRecovery({
    context: {
      runId: 'kimi-run',
      chatId: 'chat',
      workspacePath: '/workspace',
      assignedScope: {
        kind: 'lane',
        intent: 'write',
        paths: [{ kind: 'path', path: 'src/owned.ts' }]
      }
    },
    gateway: { readiness } as KimiHttpMcpBridgeHandle,
    onReceipt: (receipt) => receipts.push(receipt),
    readToolSnapshot: readToolSnapshot ?? (async () => toolSnapshot ?? null),
    timeoutMs: 1
  })
  const serve = () => {
    const generation = readiness.snapshot().generation
    readiness.responseServed(generation, 'initialize', {
      result: { protocolVersion: '2025-03-26' }
    })
    readiness.responseServed(generation, 'tools/list', {
      result: { tools: [{ name: 'read_file' }, { name: 'replace' }] }
    })
  }
  return { readiness, receipts, recovery, serve }
}

const request = (id: number, toolName = 'Edit'): AcpPermissionRequest => ({
  rpcId: id,
  sessionId: 'session',
  toolName,
  toolKind: 'edit',
  options: [],
  rawToolCall: { toolCallId: `tool-${id}`, rawInput: { old_string: 'PRIVATE FILE CONTENT' } }
})

describe('Kimi run recovery', () => {
  it.each([200, 400])(
    'fences stale prompt observations and timestamp regressions (%s)',
    async (oldTime) => {
      vi.useFakeTimers()
      vi.setSystemTime(150)
      try {
        let releaseA!: (snapshot: KimiProviderToolSnapshot) => void
        let releaseB!: (snapshot: KimiProviderToolSnapshot) => void
        const a = new Promise<KimiProviderToolSnapshot>((resolve) => {
          releaseA = resolve
        })
        const b = new Promise<KimiProviderToolSnapshot>((resolve) => {
          releaseB = resolve
        })
        const reads = [
          a,
          b,
          Promise.resolve({
            sessionId: 'session',
            observedAt: 275,
            currentRun: true,
            toolNames: ['Bash']
          })
        ]
        let read = 0
        const { recovery, serve } = fixture(undefined, () => reads[read++])
        serve()
        await recovery.prepareSessionPrompt({
          sessionId: 'session',
          resumed: true,
          fallbackFromResume: false,
          prompt: 'original'
        })
        const pendingA = recovery.observeProviderTools()
        vi.setSystemTime(250)
        recovery.externalSteer()
        const pendingB = recovery.observeProviderTools()
        releaseB({
          sessionId: 'session',
          observedAt: 300,
          currentRun: true,
          toolNames: ['Read', 'mcp__taskwraith__read_file']
        })
        await pendingB
        releaseA({
          sessionId: 'session',
          observedAt: oldTime,
          currentRun: true,
          toolNames: ['Bash']
        })
        await pendingA
        await recovery.observeProviderTools()
        expect(recovery.snapshot()).toMatchObject({
          outcome: 'running',
          brokerToolNames: ['mcp__taskwraith__read_file'],
          nativeTools: { catalogueObservedAt: new Date(300).toISOString() }
        })
        expect(recovery.boundaryAction()).toBeNull()
        recovery.close()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('blocks fresh model-side catalogue loss before any native metadata fallback', async () => {
    const { recovery, serve } = fixture({
      sessionId: 'session',
      observedAt: 200,
      currentRun: true,
      toolNames: ['Bash', 'CreateGoal', 'UpdateGoal', 'TaskStop', 'EnterPlanMode']
    })
    serve()
    await recovery.prepareSessionPrompt({
      sessionId: 'session',
      resumed: true,
      fallbackFromResume: false,
      prompt: 'review only'
    })
    await recovery.observeProviderTools()
    expect(recovery.snapshot()).toMatchObject({
      outcome: 'blocked',
      modelToolVisibility: 'provider-tools-snapshot',
      brokerToolNames: [],
      gateway: { toolNames: ['read_file', 'replace'] },
      nativeTools: {
        catalogueIsCurrent: true,
        catalogue: ['Bash', 'CreateGoal', 'UpdateGoal', 'TaskStop', 'EnterPlanMode']
      },
      refusals: []
    })
    expect(recovery.boundaryAction()).toMatchObject({
      kind: 'blocked',
      message: expect.stringContaining('current model tool snapshot')
    })
    recovery.close()
  })

  it('labels an older snapshot without treating it as a current missing-tool blocker', async () => {
    const { recovery, serve } = fixture({
      sessionId: 'session',
      observedAt: 100,
      currentRun: false,
      toolNames: ['Bash']
    })
    serve()
    await recovery.prepareSessionPrompt({
      sessionId: 'session',
      resumed: true,
      fallbackFromResume: false,
      prompt: 'review'
    })
    await recovery.observeProviderTools()
    expect(recovery.snapshot()).toMatchObject({
      outcome: 'running',
      nativeTools: { catalogueIsCurrent: false },
      modelToolVisibility: 'not-observed'
    })
    expect(recovery.boundaryAction()).toBeNull()
    recovery.close()
  })

  it('recovers a missing resumed catalogue, then returns an exact blocker for failed recovery', async () => {
    const { recovery } = fixture()
    expect(
      await recovery.prepareSessionPrompt({
        sessionId: 'old',
        resumed: true,
        fallbackFromResume: false,
        prompt: 'slim'
      })
    ).toMatchObject({ status: 'recover' })
    expect(
      await recovery.prepareSessionPrompt({
        sessionId: 'fresh',
        resumed: false,
        fallbackFromResume: true,
        prompt: 'full'
      })
    ).toMatchObject({
      status: 'blocked',
      message: expect.stringContaining('tools/list responses=0')
    })
    expect(recovery.snapshot()).toMatchObject({ outcome: 'blocked', lifecycleSettled: false })
    recovery.close()
    expect(recovery.snapshot()).toMatchObject({ outcome: 'blocked', lifecycleSettled: true })
  })

  it('gives the worker the same receipt persisted for the Captain without claiming model visibility', async () => {
    const { recovery, receipts, serve } = fixture()
    serve()
    const prepared = await recovery.prepareSessionPrompt({
      sessionId: 'session',
      resumed: true,
      fallbackFromResume: false,
      prompt: 'original task'
    })
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') throw new Error('not ready')
    const worker = JSON.parse(prepared.prompt!.split('\n')[1])
    expect(worker).toEqual(receipts.at(-1))
    expect(worker).toMatchObject({
      modelToolVisibility: 'not-observed',
      nativeTools: { catalogue: null, enforcement: 'not-attested' },
      assignedScope: { paths: [{ kind: 'path', path: 'src/owned.ts' }] }
    })
    expect(prepared.prompt).toContain('private runtime storage, not the project root')
    recovery.close()
  })

  it('records exact system refusals once, offers one correction, and bounds further native retries', () => {
    const { recovery, serve } = fixture()
    serve()
    recovery.permissionResult(request(1), 'deny')
    recovery.permissionResult(request(1), 'deny')
    expect(recovery.boundaryAction()?.kind).toBe('correct')
    expect(recovery.boundaryAction()).toBeNull()
    recovery.permissionResult(request(2), 'deny')
    expect(recovery.boundaryAction()?.kind).toBe('blocked')
    const receipt = recovery.snapshot()
    expect(receipt.refusals).toHaveLength(2)
    expect(receipt.refusals[0]).toMatchObject({
      toolCallId: 'tool-1',
      decisionSource: 'system',
      source: 'host-containment',
      userAsked: false
    })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE FILE CONTENT')
    expect(receipt.lifecycleSettled).toBe(false)
    recovery.close()
  })

  it('does not reinterpret a broker denial as host containment or retry it', () => {
    const { recovery, serve } = fixture()
    serve()
    recovery.permissionResult(request(1, 'mcp__taskwraith__replace'), 'deny')
    expect(recovery.snapshot().refusals).toEqual([])
    expect(recovery.boundaryAction()).toBeNull()
    recovery.close()
  })

  it('records canonical native identity without copying provider display text or edit arguments', () => {
    const { recovery } = fixture()
    const denied = request(1, 'PRIVATE DISPLAY TEXT')
    denied.rawToolCall = {
      toolCallId: 'tool-1',
      rawInput: { tool_name: 'Edit', old_string: 'PRIVATE SOURCE' }
    }
    recovery.permissionResult(denied, 'deny')
    expect(recovery.snapshot().refusals[0].toolName).toBe('Edit')
    expect(JSON.stringify(recovery.snapshot())).not.toContain('PRIVATE')
    recovery.close()
  })

  it('requires new broker progress to reset refusals and preserves an external steer', () => {
    const { recovery, readiness, serve } = fixture()
    serve()
    recovery.permissionResult(request(1), 'deny')
    readiness.responseServed(0, 'tools/call', { result: { content: [], isError: false } })
    expect(recovery.snapshot().modelToolVisibility).toBe('broker-call-observed')
    recovery.permissionResult(request(2), 'deny')
    expect(recovery.boundaryAction()?.kind).toBe('correct')
    recovery.permissionResult(request(3), 'deny')
    expect(recovery.boundaryAction()?.kind).toBe('blocked')
    recovery.externalSteer()
    expect(recovery.boundaryAction()).toBeNull()
    expect(recovery.snapshot().outcome).toBe('running')
    recovery.close()
  })
})
