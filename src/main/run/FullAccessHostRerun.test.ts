import { describe, expect, it, vi } from 'vitest'
import { runFullAccessHostRerun } from './FullAccessHostRerun'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'

function fixture() {
  const run = {
    runId: 'r',
    status: 'running',
    state: {
      effectivePermissions: resolveEffectiveRunPermissions({
        provider: 'codex',
        presetId: 'full_access',
        settings: {
          agenticServices: {
            shellCommands: 'ask',
            fileChanges: 'ask',
            mcpTools: 'ask',
            subThreadDelegation: 'ask',
            canvasInteraction: 'ask',
            canvasEval: 'ask',
            networkAccess: 'allow'
          },
          agenticWorkspaceGrants: []
        }
      })
    }
  }
  return {
    manager: { get: () => run, getClaimedTerminalStatus: vi.fn((): unknown => undefined) },
    runId: 'r',
    audit: vi.fn(),
    execute: vi.fn(async () => true),
    onOutcome: vi.fn()
  }
}

describe('automatic Host rerun outcome', () => {
  it('records cancellation when the run ends between permission and execution', async () => {
    const input = fixture()
    input.audit.mockImplementation(() =>
      input.manager.getClaimedTerminalStatus.mockReturnValue('cancelled')
    )
    expect(await runFullAccessHostRerun(input)).toBe('cancelled')
    expect(input.execute).not.toHaveBeenCalled()
    expect(input.onOutcome).toHaveBeenCalledExactlyOnceWith('cancelled')
  })

  it('distinguishes an execution rejected by the host from a command actually run', async () => {
    const input = fixture()
    input.execute.mockResolvedValue(false)
    expect(await runFullAccessHostRerun(input)).toBe('not-started')
    expect(input.onOutcome).toHaveBeenCalledExactlyOnceWith('not-started')
  })

  it('records failures and propagates the original error', async () => {
    const input = fixture()
    input.execute.mockRejectedValue(new Error('spawn failed'))
    await expect(runFullAccessHostRerun(input)).rejects.toThrow('spawn failed')
    expect(input.onOutcome).toHaveBeenCalledExactlyOnceWith('failed')
  })

  it('reports actual execution separately from permission', async () => {
    const input = fixture()
    expect(await runFullAccessHostRerun(input)).toBe('executed')
    expect(input.onOutcome).toHaveBeenCalledExactlyOnceWith('executed')
  })
})
