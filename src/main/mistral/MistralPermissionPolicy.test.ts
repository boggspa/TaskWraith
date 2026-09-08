import { describe, expect, it, vi } from 'vitest'
import type { AcpPermissionRequest } from '../grok/GrokAcpProtocol'
import type { NativeWorkspaceToolPreflight } from '../native-tools/NativeWorkspaceToolGate'
import {
  createMistralPermissionHandler,
  mistralPermissionLedgerRecord
} from './MistralPermissionPolicy'

const request: AcpPermissionRequest = {
  rpcId: 9,
  sessionId: 'native-session',
  toolName: 'bash',
  toolKind: 'execute',
  rawToolCall: { toolCallId: 'call-1' },
  options: []
}
const read: NativeWorkspaceToolPreflight = {
  kind: 'allow',
  canonicalTool: 'read_file',
  source: 'native',
  service: 'fileChanges',
  access: 'read',
  checkedPaths: ['/workspace/file'],
  requiresRuntimeSandbox: false
}
const shellRefusal: NativeWorkspaceToolPreflight = {
  kind: 'deny',
  canonicalTool: 'run_shell_command',
  source: 'native',
  reason: 'Native shell requires a runtime workspace sandbox.',
  checkedPaths: ['/workspace'],
  requiresRuntimeSandbox: true
}

function handler(overrides: Partial<Parameters<typeof createMistralPermissionHandler>[0]> = {}) {
  return createMistralPermissionHandler({
    isBrokerTool: () => false,
    isNetworkRead: () => false,
    networkAllowed: () => false,
    preflight: () => read,
    isReadOnlyShell: () => false,
    readOnlySeat: false,
    ...overrides
  })
}

describe('Mistral native permission provenance without changing the gate', () => {
  it('leaves authenticated broker approval to the broker', () => {
    const preflight = vi.fn()
    expect(handler({ isBrokerTool: () => true, preflight })(request)).toBe('allow')
    expect(preflight).not.toHaveBeenCalled()
  })

  it('preserves native read and previously allowed read-only shell decisions', () => {
    expect(handler({ readOnlySeat: true })(request)).toBe('allow')
    expect(
      handler({
        preflight: () => ({
          kind: 'not_applicable',
          canonicalTool: 'run_shell_command',
          source: 'native'
        }),
        isReadOnlyShell: () => true,
        readOnlySeat: true
      })(request)
    ).toBe('allow')
  })

  it('never lets a native read-only shell hint bypass the workspace preflight', () => {
    const isReadOnlyShell = vi.fn(() => true)
    expect(handler({ preflight: () => shellRefusal, isReadOnlyShell })(request)).toMatchObject({
      decision: 'deny',
      origin: 'host-containment',
      reason: shellRefusal.reason
    })
    expect(isReadOnlyShell).not.toHaveBeenCalled()
  })

  it('keeps outside-workspace and unknown-action refusals distinct from transport recovery', () => {
    for (const reason of [
      'Native shell cwd is outside the active workspace.',
      'Native action is not declared.'
    ]) {
      expect(
        handler({ preflight: () => ({ ...shellRefusal, checkedPaths: [], reason }) })(request)
      ).toEqual({
        decision: 'deny',
        origin: 'host-policy',
        reason
      })
    }
  })

  it('retains network denial and the read-only seat policy', () => {
    expect(handler({ isNetworkRead: () => true })(request)).toMatchObject({
      decision: 'deny',
      origin: 'host-policy'
    })
    const preflight = () => ({ ...read, access: 'write' as const })
    expect(handler({ preflight, readOnlySeat: true })(request)).toMatchObject({
      decision: 'deny',
      origin: 'host-policy'
    })
    expect(handler({ preflight })(request)).toMatchObject({
      decision: 'deny',
      origin: 'host-containment'
    })
    expect(handler({ isNetworkRead: () => true, networkAllowed: () => true })(request)).toBe(
      'allow'
    )
    expect(
      handler({
        preflight: () => ({ kind: 'not_applicable', canonicalTool: 'unknown', source: 'native' })
      })(request)
    ).toMatchObject({ decision: 'deny', origin: 'host-policy' })
  })

  it('records the exact run and system origin with no pending human approval', () => {
    const record = mistralPermissionLedgerRecord(
      { runId: 'run-a', chatId: 'chat-a', workspacePath: '/workspace' },
      request,
      { decision: 'deny', origin: 'host-containment', reason: shellRefusal.reason }
    )
    expect(record).toMatchObject({
      runId: 'run-a',
      chatId: 'chat-a',
      providerSessionId: 'native-session',
      rpcId: 9,
      status: 'denied',
      decision: 'autoDeny',
      decisionSource: 'system',
      metadata: { refusalOrigin: 'host-containment', toolName: 'bash' }
    })
    expect(record.body).toContain('no human was asked')
    expect(record.actions).toEqual([])
    expect(record.params).toBeUndefined()
  })
})
