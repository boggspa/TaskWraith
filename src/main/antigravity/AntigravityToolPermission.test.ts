import { describe, expect, it } from 'vitest'
import type { AcpPermissionRequest } from '../acp/AcpProtocol'
import { MainSourceProbe } from '../mainSourceProbe.testutil'
import type { NativeWorkspaceToolPreflight } from '../native-tools/NativeWorkspaceToolGate'
import {
  agyHostPolicyRefusal,
  captureAgyApproval,
  createAntigravityAcpPermissionHandler
} from './AntigravityToolPermission'

const probe = new MainSourceProbe('src/main/index.ts', new URL('../index.ts', import.meta.url))

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
    // Name-anchored instead of text-sliced. `indexOf('async function
    // runAntigravityAgyProvider(')` reds on any signature reflow, and the end
    // anchor was worse than brittle: when `indexOf('\n}\n')` missed,
    // `slice(0, -1)` silently widened the region to the rest of the file, so
    // denials from unrelated functions could satisfy the loop below. `fn`
    // throws when the entry point is renamed, moved or deleted, and returns
    // exactly this function's body.
    const hook = probe.fn('runAntigravityAgyProvider')

    // Was a TEN-LINE WINDOW over the hook's text: for each line matching
    // `decision: 'deny'`, assert the next ten lines mention `onReplyWritten`.
    // That was wrong in both directions at once. It passed when a denial lost
    // its own receipt but a NEIGHBOUR's callback fell inside the window
    // (demonstrated against a doctored index.ts: 7 denials, 6 receipts, green),
    // and it red when a denial was merely reformatted so its own callback sat
    // eleven lines below. Read per-object, neither failure is expressible.
    const denials = probe
      .objectLiterals(hook)
      .filter((object) => probe.propOf(object, 'decision') === "'deny'")

    // Exact, so a denial that disappears is as loud as one that loses its
    // receipt, and so the loop below cannot run over an empty collection.
    expect(denials).toHaveLength(6)
    for (const denial of denials) {
      expect(probe.propOf(denial, 'onReplyWritten')).not.toBeNull()
    }

    // Companion to the ten-line window above, which cannot tell a denial's own
    // `onReplyWritten` from the next denial's a few lines further down. Every
    // receipt row is written by an `agyToolReceipt?.refusal(...)` call inside
    // one of those callbacks, so one refusal call per denial is the arithmetic
    // the window check silently assumes. A denial that loses its receipt reds
    // here even when the window spills onto a neighbour's, and a refusal call
    // deleted without its denial reds too.
    expect(probe.callsTo(hook, 'refusal')).toHaveLength(denials.length)
  })
})
