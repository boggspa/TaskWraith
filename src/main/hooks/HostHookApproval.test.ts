import { describe, expect, it, vi } from 'vitest'
import { createHostHookApproval } from './HostHookApproval'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'

const permissions = (presetId: 'full_access' | 'workspace_write' | 'read_only') =>
  resolveEffectiveRunPermissions({
    provider: 'claude',
    presetId,
    settings: {
      agenticServices: {
        shellCommands: 'ask',
        fileChanges: 'ask',
        mcpTools: 'ask',
        subThreadDelegation: 'ask',
        canvasInteraction: 'ask',
        canvasEval: 'deny',
        networkAccess: 'allow'
      },
      agenticWorkspaceGrants: []
    }
  })

describe('host hook lifecycle approval', () => {
  it('keeps a restricted Stop hook askable independently of its terminal provider run', async () => {
    const request = vi.fn(async (_command: string, runId: string | undefined) => !runId)
    const auditTerminalFullAccess = vi.fn()
    const approve = createHostHookApproval({
      runId: 'ended-run',
      terminal: { permissions: permissions('workspace_write') },
      request,
      auditTerminalFullAccess
    })
    expect(await approve('user-configured-stop')).toBe(true)
    expect(request).toHaveBeenCalledExactlyOnceWith('user-configured-stop', undefined)
    expect(auditTerminalFullAccess).not.toHaveBeenCalled()
  })

  it('audits a Full Access Stop hook without reopening the terminal run or creating a card', async () => {
    const request = vi.fn(async () => false)
    const auditTerminalFullAccess = vi.fn()
    const approve = createHostHookApproval({
      runId: 'ended-run',
      terminal: { permissions: permissions('full_access') },
      request,
      auditTerminalFullAccess
    })
    expect(await approve('user-configured-stop')).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(auditTerminalFullAccess).toHaveBeenCalledExactlyOnceWith('user-configured-stop')
  })

  it('does not give ordinary Pre/Post hooks authority after their provider is cancelled', async () => {
    const request = vi.fn(async () => false)
    const auditTerminalFullAccess = vi.fn()
    const approve = createHostHookApproval({
      runId: 'cancelled-run',
      request,
      auditTerminalFullAccess
    })
    expect(await approve('late-tool-hook')).toBe(false)
    expect(request).toHaveBeenCalledExactlyOnceWith('late-tool-hook', 'cancelled-run')
    expect(auditTerminalFullAccess).not.toHaveBeenCalled()
  })

  it('preserves human refusal when the Stop hook has no captured Full Access authority', async () => {
    const request = vi.fn(async () => false)
    const auditTerminalFullAccess = vi.fn()
    const approve = createHostHookApproval({ terminal: {}, request, auditTerminalFullAccess })
    expect(await approve('stop')).toBe(false)
    expect(auditTerminalFullAccess).not.toHaveBeenCalled()
  })
})
