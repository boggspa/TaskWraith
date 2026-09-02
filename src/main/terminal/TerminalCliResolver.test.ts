import os from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildInteractiveTerminalLaunchCommand,
  resolveInteractiveTerminalCli
} from './TerminalCliResolver'

describe('resolveInteractiveTerminalCli', () => {
  it('resolves provider CLIs in main and returns an absolute launch command', async () => {
    const resolveProviderBinary = vi.fn(async () => ({
      binaryPath: '/Users/dev/.kimi-code/bin/kimi'
    }))

    // The launch command is quoted per-platform; pin the POSIX branch so the
    // expectation is deterministic on the Windows leg too.
    const resolved = await resolveInteractiveTerminalCli('kimi', {
      resolveProviderBinary,
      platform: 'linux'
    })

    expect(resolveProviderBinary).toHaveBeenCalledWith('kimi')
    expect(resolved).toMatchObject({
      cliId: 'kimi',
      command: 'kimi',
      binaryPath: '/Users/dev/.kimi-code/bin/kimi',
      launchCommand: "'/Users/dev/.kimi-code/bin/kimi'"
    })
  })

  it('uses the interactive Vibe binary, not the Mistral provider transport', async () => {
    const vibePath = join(os.tmpdir(), 'vibe')
    const findExecutable = vi.fn((command: string) => (command === 'vibe' ? vibePath : null))

    const resolved = await resolveInteractiveTerminalCli('mistral', { findExecutable })

    expect(findExecutable).toHaveBeenCalledWith('vibe')
    expect(resolved.command).toBe('vibe')
    expect(resolved.binaryPath).toBe(vibePath)
  })

  it('quotes POSIX and PowerShell executable paths', () => {
    expect(buildInteractiveTerminalLaunchCommand("/opt/Chris's CLI/bin/kimi", 'linux')).toBe(
      "'/opt/Chris'\\''s CLI/bin/kimi'"
    )
    expect(
      buildInteractiveTerminalLaunchCommand("C:\\Program Files\\Chris's CLI\\kimi.exe", 'win32')
    ).toBe("& 'C:\\Program Files\\Chris''s CLI\\kimi.exe'")
  })
})
