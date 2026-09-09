import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import type { AcpPermissionRequest } from '../acp/AcpProtocol'
import type { NativeWorkspaceToolPreflight } from '../native-tools/NativeWorkspaceToolGate'
import {
  agyHostPolicyRefusal,
  captureAgyApproval,
  createAntigravityAcpPermissionHandler
} from './AntigravityToolPermission'

const request: AcpPermissionRequest = {
  rpcId: 1,
  sessionId: 's',
  toolName: 'bash',
  toolKind: 'execute',
  options: [],
  rawToolCall: {}
}
const preflights: NativeWorkspaceToolPreflight[] = [
  { kind: 'not_applicable', source: 'native', canonicalTool: null },
  {
    kind: 'deny',
    source: 'native',
    canonicalTool: 'run_shell_command',
    checkedPaths: ['/workspace'],
    requiresRuntimeSandbox: true,
    reason: 'sandbox'
  },
  {
    kind: 'deny',
    source: 'native',
    canonicalTool: 'run_shell_command',
    checkedPaths: [],
    requiresRuntimeSandbox: true,
    reason: 'outside workspace'
  },
  {
    kind: 'allow',
    source: 'native',
    canonicalTool: 'read_file',
    checkedPaths: ['/workspace/a'],
    access: 'read',
    service: 'fileChanges',
    requiresRuntimeSandbox: false
  },
  {
    kind: 'allow',
    source: 'native',
    canonicalTool: 'replace',
    checkedPaths: ['/workspace/a'],
    access: 'write',
    service: 'fileChanges',
    requiresRuntimeSandbox: false
  }
]
describe('AntiGravity gate outcome preservation', () => {
  it('matches the old decision order across broker, preflight and read-only-shell combinations', () => {
    for (const broker of [false, true])
      for (const readonlyShell of [false, true])
        for (const preflight of preflights) {
          const decision = createAntigravityAcpPermissionHandler({
            isBrokerTool: () => broker,
            preflight: () => preflight,
            isReadOnlyShell: () => readonlyShell
          })(request)
          const expected = broker
            ? 'allow'
            : preflight.kind === 'deny'
              ? 'deny'
              : preflight.kind === 'allow' && preflight.access === 'read'
                ? 'allow'
                : readonlyShell
                  ? 'allow'
                  : 'deny'
          expect(typeof decision === 'string' ? decision : decision.decision).toBe(expected)
        }
  })
  it.each(['human', 'system', 'unknown', 'allowed'] as const)(
    'preserves %s provenance from the real agy approval callback',
    async (caseName) => {
      const result = await captureAgyApproval({
        toolCallId: 'call-1',
        toolName: 'run_command',
        request: async (hooks) => {
          if (caseName === 'human' || caseName === 'system') {
            hooks.onApprovalPromptCreated({ approvalId: 'approval-1' })
            hooks.resolveAction('decline', caseName === 'human' ? 'user' : 'system')
          }
          return caseName === 'allowed'
        }
      })
      expect(result.allowed).toBe(caseName === 'allowed')
      expect(result.refusal?.origin ?? null).toBe(
        caseName === 'allowed' ? null : caseName === 'system' ? 'system-cancelled' : caseName
      )
    }
  )
})

describe('unattributed agy hook denials', () => {
  it('records a host-policy refusal that carries no provider call id', () => {
    const refusal = agyHostPolicyRefusal({
      toolName: 'mcp__taskwraith__not_a_real_action',
      operationId: 'agy-reserved-namespace-1',
      reason: 'reserved namespace'
    })
    expect(refusal).toEqual({
      toolCallId: null,
      toolName: 'mcp__taskwraith__not_a_real_action',
      operationId: 'agy-reserved-namespace-1',
      origin: 'host-policy',
      decisionSource: 'system',
      reason: 'reserved namespace',
      reply: 'transport-written'
    })
  })

  it('keeps two unattributed refusals in one run distinguishable', () => {
    const first = agyHostPolicyRefusal({ toolName: 't', operationId: 'a-1', reason: 'r' })
    const second = agyHostPolicyRefusal({ toolName: 't', operationId: 'a-2', reason: 'r' })
    expect(first.toolCallId).toBeNull()
    expect(second.toolCallId).toBeNull()
    expect(first.operationId).not.toBe(second.operationId)
  })

  it('leaves no agy hook denial without a receipt row', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function runAntigravityAgyProvider(')
    expect(start).toBeGreaterThan(-1)
    const rest = source.slice(start)
    const lines = rest.slice(0, rest.indexOf('\n}\n')).split('\n')

    const denials = lines
      .map((line, index) => ({ line, index }))
      .filter((row) => /decision: 'deny'/.test(row.line))

    // Guards the loop below against passing vacuously if the hook is restructured.
    expect(denials.length).toBeGreaterThanOrEqual(6)

    for (const row of denials) {
      expect(lines.slice(row.index, row.index + 10).join('\n')).toContain('onReplyWritten')
    }
  })
})
