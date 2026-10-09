import { describe, expect, it, vi } from 'vitest'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  clampUntrustedRunPosture,
  signRunPermissionPosture,
  verifyRunPermissionPosture
} from '../RunPermissionPosture'
import {
  fullAccessNativePreflight,
  createFullAccessNativePermissionHandler,
  resolveFullAccessNativeRun,
  settleFullAccessNativeDecision
} from './FullAccessNativeDecision'

function fixture() {
  const settings = {
    agenticServices: {
      shellCommands: 'ask' as const,
      fileChanges: 'ask' as const,
      mcpTools: 'ask' as const,
      subThreadDelegation: 'ask' as const,
      canvasInteraction: 'ask' as const,
      canvasEval: 'ask' as const,
      networkAccess: 'allow' as const
    },
    agenticWorkspaceGrants: []
  }
  const effectivePermissions = resolveEffectiveRunPermissions({
    provider: 'codex',
    settings,
    presetId: 'full_access'
  })
  const run = { runId: 'run-1', status: 'running', state: { effectivePermissions } }
  const manager = {
    get: vi.fn(() => run),
    getClaimedTerminalStatus: vi.fn((): unknown => undefined)
  }
  return { run, manager, audit: vi.fn(), execute: vi.fn(), runId: run.runId }
}

describe('direct native Full Access decisions', () => {
  it('auto-accepts native callbacks and preserves the restricted fallback', async () => {
    const input = fixture()
    const fallback = vi.fn(() => 'denied-by-existing-policy')
    const handler = createFullAccessNativePermissionHandler({ ...input, fallback })
    expect(await handler({ toolName: 'native-shell' })).toBe('allow')
    expect(fallback).not.toHaveBeenCalled()
    input.run.state.effectivePermissions.presetId = 'workspace_write'
    expect(await handler({ toolName: 'native-shell' })).toBe('denied-by-existing-policy')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('settles withdrawn native permissions as deny without entering the restricted fallback', async () => {
    const input = fixture()
    const fallback = vi.fn(() => 'allow')
    input.audit.mockImplementation(() => {
      input.manager.getClaimedTerminalStatus.mockReturnValue('cancelled')
    })
    const handler = createFullAccessNativePermissionHandler({ ...input, fallback })
    expect(await handler({ toolName: 'native-shell' })).toBe('deny')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('does not reopen a terminal run through its permissive restricted-tier fallback', async () => {
    const input = fixture()
    const fallback = vi.fn(() => 'allow')
    input.run.status = 'cancelled'
    const handler = createFullAccessNativePermissionHandler({ ...input, fallback })
    expect(await handler({ toolName: 'native-read' })).toBe('deny')
    expect(fallback).not.toHaveBeenCalled()
    expect(input.audit).not.toHaveBeenCalled()
  })

  it('projects automatic native permission only from an active admitted Full Access run', () => {
    const input = fixture()
    expect(fullAccessNativePreflight(input.manager, input.runId)).toMatchObject({
      kind: 'allow',
      policy: 'allow',
      reason: 'trusted_session',
      scope: 'request'
    })
    input.run.state.effectivePermissions.presetId = 'default'
    expect(fullAccessNativePreflight(input.manager, input.runId)).toBeNull()
  })

  it('audits then executes the exact admitted operation without a pending card', async () => {
    const input = fixture()
    const order: string[] = []
    input.audit.mockImplementation(() => {
      order.push('audit')
    })
    input.execute.mockImplementation(() => {
      order.push('execute')
    })
    expect(await settleFullAccessNativeDecision(input)).toBe('accepted')
    expect(order).toEqual(['audit', 'execute'])
    expect(input.execute).toHaveBeenCalledExactlyOnceWith(input.run)
  })

  it.each(['unsigned', 'tampered'] as const)(
    'refuses %s elevation after real admission clamp',
    async (kind) => {
      const input = fixture()
      const secret = Buffer.from('a'.repeat(64), 'hex')
      const permissions = input.run.state.effectivePermissions
      const signature = signRunPermissionPosture(secret, 'auto_edit', permissions)
      const restricted = { ...permissions, presetId: 'plan' as const, readOnly: true }
      const clamped = clampUntrustedRunPosture(
        {
          scope: 'workspace',
          approvalMode: 'auto_edit',
          effectivePermissions: permissions,
          signature:
            kind === 'unsigned'
              ? undefined
              : `${signature[0] === 'f' ? 'e' : 'f'}${signature.slice(1)}`
        },
        {
          verify: (mode, value, seal, context) =>
            verifyRunPermissionPosture(secret, mode, value, seal, context),
          reDeriveReadOnly: () => restricted,
          reDeriveDefault: () => restricted
        }
      )
      input.run.state.effectivePermissions = clamped.effectivePermissions!
      expect(await settleFullAccessNativeDecision(input)).toBe('not-full-access')
      expect(input.execute).not.toHaveBeenCalled()
    }
  )

  it.each(['done', 'cancelled', 'failed', 'waiting_approval'])(
    'refuses inactive status %s',
    async (status) => {
      const input = fixture()
      input.run.status = status
      expect(resolveFullAccessNativeRun(input.manager, input.runId)).toBeNull()
      expect(await settleFullAccessNativeDecision(input)).toBe('not-full-access')
    }
  )

  it('rechecks terminal/cancellation state after awaited audit', async () => {
    const input = fixture()
    input.audit.mockImplementation(() => {
      input.manager.getClaimedTerminalStatus.mockReturnValue('cancelled')
    })
    expect(await settleFullAccessNativeDecision(input)).toBe('cancelled')
    expect(input.execute).not.toHaveBeenCalled()
  })

  it('does not audit or execute an already aborted request', async () => {
    const input = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(await settleFullAccessNativeDecision({ ...input, signal: controller.signal })).toBe(
      'cancelled'
    )
    expect(input.audit).not.toHaveBeenCalled()
    expect(input.execute).not.toHaveBeenCalled()
  })

  it('propagates audit failure and never invokes the operation', async () => {
    const input = fixture()
    input.audit.mockRejectedValue(new Error('audit unavailable'))
    await expect(settleFullAccessNativeDecision(input)).rejects.toThrow('audit unavailable')
    expect(input.execute).not.toHaveBeenCalled()
  })

  it('refuses a replacement run even with the same id and permissions', async () => {
    const input = fixture()
    input.audit.mockImplementation(() => {
      input.manager.get.mockReturnValue({ ...input.run })
    })
    expect(await settleFullAccessNativeDecision(input)).toBe('cancelled')
    expect(input.execute).not.toHaveBeenCalled()
  })

  it('honors cancellation and admission withdrawal during awaited audit', async () => {
    for (const kind of ['signal', 'admission'] as const) {
      const input = fixture()
      const controller = new AbortController()
      let blocked = false
      input.audit.mockImplementation(() => {
        if (kind === 'signal') controller.abort()
        else blocked = true
      })
      expect(
        await settleFullAccessNativeDecision({
          ...input,
          signal: controller.signal,
          admissionBlocked: () => blocked
        })
      ).toBe('cancelled')
      expect(input.execute).not.toHaveBeenCalled()
    }
  })

  it('does not infer Full Access from shell allow on a different tier', async () => {
    const input = fixture()
    input.run.state.effectivePermissions.presetId = 'workspace_write'
    expect(await settleFullAccessNativeDecision(input)).toBe('not-full-access')
    expect(input.audit).not.toHaveBeenCalled()
    expect(input.execute).not.toHaveBeenCalled()
  })

  it('rejects missing run id or wrong authoritative identity', async () => {
    const input = fixture()
    expect(await settleFullAccessNativeDecision({ ...input, runId: undefined })).toBe(
      'not-full-access'
    )
    expect(await settleFullAccessNativeDecision({ ...input, runId: 'other-run' })).toBe(
      'not-full-access'
    )
    expect(input.execute).not.toHaveBeenCalled()
  })
})
