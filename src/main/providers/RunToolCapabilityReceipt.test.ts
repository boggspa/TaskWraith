import { describe, expect, it } from 'vitest'
import type { ProviderId } from '../store/types'
import { prepareRunEventPayload } from '../RunEventStore'
import {
  createRunToolCapabilityReceipt,
  resolveRunToolScope,
  toolRecoveryDisposition,
  type RunToolCapabilityContext,
  type ToolRefusalOrigin
} from './RunToolCapabilityReceipt'

export function receiptContext(
  provider: ProviderId = 'cursor',
  transport = 'cursor-path-b'
): RunToolCapabilityContext {
  return {
    runId: 'run-1',
    chatId: 'chat-1',
    provider,
    transport,
    model: 'model-1',
    scope: { kind: 'workspace', workspacePath: '/workspace', paths: [{ kind: 'workspace' }] },
    effectivePermissions: null
  }
}

const transports: [ProviderId, string][] = [
  ['antigravity', 'agy-print'],
  ['antigravity', 'antigravity-acp'],
  ['antigravity', 'gemini-api'],
  ['cursor', 'cursor-path-b'],
  ['pi', 'pi-rpc'],
  ['ollama', 'ollama-local'],
  ['ollama', 'ollama-cloud-daemon'],
  ['ollama', 'ollama-cloud-api'],
  ['kimi', 'kimi-acp-http'],
  ['mistral', 'mistral-acp'],
  ['muse', 'muse-msp']
]

describe.each(transports)('%s / %s common tool receipt acceptance', (provider, transport) => {
  it('does not promote configured names or connection readiness into observed availability', () => {
    const r = createRunToolCapabilityReceipt(receiptContext(provider, transport))
    r.requireManagedTools(['replace'])
    r.catalogue('managed', {
      names: ['replace'],
      source: 'host-config',
      complete: true,
      namespace: 'expected'
    })
    r.connection('ready')
    expect(r.snapshot().readiness).toBe('unverified')
    expect(r.snapshot().managed.observed).toBeNull()
    r.catalogue('managed', {
      names: ['replace'],
      source: 'broker-served',
      complete: true,
      namespace: 'expected'
    })
    expect(r.snapshot().readiness).toBe('unverified')
    r.executed('managed', 'read_file')
    expect(r.snapshot().readiness).toBe('unverified')
    r.catalogue('managed', {
      names: ['read_file'],
      source: 'provider-catalogue',
      complete: true,
      namespace: 'observed'
    })
    expect(r.snapshot()).toMatchObject({ readiness: 'degraded', missingManagedTools: ['replace'] })
    r.catalogue('managed', {
      names: ['replace'],
      source: 'broker-served',
      complete: true,
      namespace: 'expected'
    })
    r.catalogue('managed', {
      names: ['replace'],
      source: 'extension-ready',
      complete: true,
      namespace: 'expected'
    })
    expect(r.snapshot()).toMatchObject({ readiness: 'degraded', missingManagedTools: ['replace'] })
    expect(r.snapshot().managed.observed!.namespace).toBe('observed')
  })

  it('ignores late catalogue responses from a replaced session and callbacks after settlement', () => {
    const r = createRunToolCapabilityReceipt(receiptContext(provider, transport))
    const old = r.snapshot().generation
    r.beginGeneration('new-session')
    expect(
      r.catalogue(
        'managed',
        { names: ['replace'], source: 'provider-catalogue', complete: true, namespace: 'old' },
        old
      )
    ).toBe(false)
    expect(r.snapshot().managed.observed).toBeNull()
    r.settle()
    expect(r.connection('ready')).toBe(false)
    expect(r.executed('managed', 'replace')).toBe(false)
    expect(r.snapshot().lifecycleSettled).toBe(true)
  })

  it('keeps incomplete discovery unknown and separates native from managed evidence', () => {
    const r = createRunToolCapabilityReceipt(receiptContext(provider, transport))
    r.requireManagedTools(['replace'])
    r.catalogue('native', {
      names: ['replace'],
      source: 'provider-catalogue',
      complete: true,
      namespace: null
    })
    r.catalogue('managed', {
      names: ['read_file'],
      source: 'provider-catalogue',
      complete: false,
      namespace: 'broker'
    })
    expect(r.snapshot()).toMatchObject({ readiness: 'unverified', missingManagedTools: [] })
    r.connection('unavailable', 'Exact broker endpoint unavailable.')
    expect(r.snapshot()).toMatchObject({
      readiness: 'degraded',
      blocker: 'Exact broker endpoint unavailable.'
    })
  })

  it('requires actual human provenance and never reroutes a repeated or absent route', () => {
    const refusal = {
      origin: 'host-containment' as const,
      decisionSource: 'system' as const,
      reply: 'transport-written' as const
    }
    expect(toolRecoveryDisposition({ refusal, routeObserved: true, attempts: 0 })).toBe(
      'retry-listed-route-once'
    )
    expect(toolRecoveryDisposition({ refusal, routeObserved: true, attempts: 1 })).toBe(
      'report-blocker'
    )
    expect(
      toolRecoveryDisposition({
        refusal,
        routeObserved: false,
        routeUnavailable: true,
        attempts: 0
      })
    ).toBe('report-blocker')
    expect(toolRecoveryDisposition({ refusal, routeObserved: false, attempts: 0 })).toBe(
      'verify-listed-route'
    )
    for (const origin of [
      'host-policy',
      'approval-timeout',
      'system-cancelled',
      'tool-unavailable',
      'provider-native',
      'unknown'
    ] as ToolRefusalOrigin[]) {
      expect(
        toolRecoveryDisposition({
          refusal: { ...refusal, origin },
          routeObserved: true,
          attempts: 0
        })
      ).toBe('report-blocker')
    }
    expect(
      toolRecoveryDisposition({
        refusal: { ...refusal, origin: 'human', decisionSource: 'user' },
        routeObserved: true,
        attempts: 0
      })
    ).toBe('respect-human-decision')
    const r = createRunToolCapabilityReceipt(receiptContext(provider, transport))
    r.refusal({
      ...refusal,
      origin: 'human',
      decisionSource: 'provider',
      toolCallId: 'a',
      toolName: 'bash',
      reason: 'User rejected'
    })
    expect(r.snapshot().refusals[0].origin).toBe('unknown')
  })
})

it('resolves absent or mismatched lane authority as unknown without a workspace fallback', () => {
  expect(
    resolveRunToolScope({
      runId: 'run-1',
      laneId: 'lane-1',
      participantId: 'p1',
      workspacePath: '/workspace',
      chat: null
    })
  ).toEqual({ kind: 'unknown', workspacePath: '/workspace', paths: [] })
  expect(resolveRunToolScope({ runId: 'run-1', scope: 'global' })).toEqual({
    kind: 'global',
    workspacePath: null,
    paths: []
  })
})

it('clones receipt and callback snapshots so another consumer cannot alter run authority', () => {
  const context = receiptContext()
  const r = createRunToolCapabilityReceipt(context, {
    onChange: (s) => {
      s.scope.paths.length = 0
    }
  })
  context.scope.paths.length = 0
  r.connection('ready')
  const snapshot = r.snapshot()
  snapshot.scope.paths.length = 0
  expect(r.snapshot().scope.paths).toEqual([{ kind: 'workspace' }])
})

it('retains confirmed historical refusal acknowledgements without reopening a settled run', () => {
  const r = createRunToolCapabilityReceipt(receiptContext())
  const first = r.snapshot().generation
  r.beginGeneration()
  r.settle()
  const refusal = {
    toolCallId: 'old-call',
    toolName: 'bash',
    origin: 'host-policy' as const,
    reason: 'Outside the assigned scope.',
    decisionSource: 'system' as const,
    reply: 'transport-written' as const
  }
  expect(r.refusal(refusal, first)).toBe(true)
  expect(r.refusal({ ...refusal, toolCallId: 'current-call' })).toBe(true)
  expect(r.refusal({ ...refusal, reply: 'not-sent' }, first)).toBe(false)
  expect(r.snapshot()).toMatchObject({
    lifecycleSettled: true,
    readiness: 'unverified',
    refusalCount: 2
  })
  expect(r.snapshot().refusals[0].generation).toBe(first)
})

it('fits maximum refusal/catalogue detail into the real durable envelope with disclosed truncation', () => {
  const r = createRunToolCapabilityReceipt(receiptContext())
  const tools = Array.from({ length: 512 }, (_, index) => `${index}-${'x'.repeat(190)}`)
  for (const surface of ['native', 'managed'] as const) {
    for (const source of [
      'host-config',
      'broker-served',
      'provider-catalogue',
      'extension-ready'
    ] as const) {
      r.catalogue(surface, { names: tools, complete: true, source, namespace: 'broker' })
    }
  }
  for (let index = 0; index < 64; index += 1)
    r.refusal({
      toolCallId: `call-${index}`,
      toolName: 'bash',
      origin: 'host-policy',
      reason: 'x'.repeat(2_000),
      decisionSource: 'system',
      reply: 'transport-written'
    })
  const snapshot = r.snapshot()
  const payload = { toolCapabilityReceipt: snapshot }
  expect(prepareRunEventPayload(payload)).toBe(payload)
  expect(snapshot.detailsTruncated).toBe(true)
  expect(snapshot.refusalCount).toBe(64)
  expect(snapshot.refusals.at(-1)?.toolCallId).toBe('call-63')
  expect(snapshot.managed.observed?.complete).toBe(false)
})
