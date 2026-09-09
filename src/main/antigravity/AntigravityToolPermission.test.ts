import { describe, expect, it } from 'vitest'
import type { AcpPermissionRequest } from '../acp/AcpProtocol'
import type { NativeWorkspaceToolPreflight } from '../native-tools/NativeWorkspaceToolGate'
import {
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
