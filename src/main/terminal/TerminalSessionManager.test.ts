import * as pty from 'node-pty'
import os from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { TerminalSessionManager } from './TerminalSessionManager'

function fakePty() {
  let dataListener: ((data: string) => void) | undefined
  let exitListener: ((event: { exitCode: number }) => void) | undefined
  const process = {
    pid: 1,
    cols: 80,
    rows: 24,
    process: '/bin/zsh',
    handleFlowControl: false,
    onData(listener: (data: string) => void) {
      dataListener = listener
      return { dispose: () => undefined }
    },
    onExit(listener: (event: { exitCode: number }) => void) {
      exitListener = listener
      return { dispose: () => undefined }
    },
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    emitData(data: string) {
      dataListener?.(data)
    },
    emitExit(exitCode: number) {
      exitListener?.({ exitCode })
    }
  }
  return process
}

describe('TerminalSessionManager', () => {
  it('waits for shell output before launching a resolved CLI', async () => {
    const shell = fakePty()
    const spawn = vi.fn(() => shell as unknown as pty.IPty)
    const resolveCli = vi.fn(async () => ({
      cliId: 'kimi' as const,
      command: 'kimi',
      binaryPath: '/Users/dev/.kimi-code/bin/kimi',
      launchCommand: "'/Users/dev/.kimi-code/bin/kimi'"
    }))
    const inheritedPath = join(os.tmpdir(), 'system-bin')
    const shellCommand = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh'
    const manager = new TerminalSessionManager(
      join(os.tmpdir(), 'taskwraith-terminal-manager-test'),
      {
        spawn,
        inheritedEnv: { PATH: inheritedPath, SHELL: '/bin/zsh' },
        resolveCli
      }
    )

    const creating = manager.create('/work/AGBench', 'terminal-1', 'kimi')

    await Promise.resolve()
    expect(resolveCli).not.toHaveBeenCalled()
    expect(shell.write).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      shellCommand,
      [],
      expect.objectContaining({
        cwd: '/work/AGBench',
        env: expect.objectContaining({
          HOME: expect.stringContaining('/terminal-home/'),
          PATH: expect.stringContaining(inheritedPath),
          SHELL: '/bin/zsh'
        })
      })
    )

    shell.emitData('$ ')
    await expect(creating).resolves.toBeTruthy()

    expect(resolveCli).toHaveBeenCalledWith('kimi')
    expect(shell.write).toHaveBeenCalledWith("'/Users/dev/.kimi-code/bin/kimi'\r")
    expect(manager.getScrollback('terminal-1')).toBe('$ ')
    manager.kill('terminal-1')
  })

  it('surfaces a missing quickload CLI without preventing the terminal from opening', async () => {
    const shell = fakePty()
    const manager = new TerminalSessionManager(
      join(os.tmpdir(), 'taskwraith-terminal-manager-test'),
      {
        spawn: vi.fn(() => shell as unknown as pty.IPty),
        inheritedEnv: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
        resolveCli: vi.fn(async () => {
          throw new Error('Kimi CLI was not found.')
        })
      }
    )

    const creating = manager.create('/work/AGBench', 'terminal-2', 'kimi')
    shell.emitData('$ ')
    await expect(creating).resolves.toBeTruthy()

    expect(manager.getScrollback('terminal-2')).toContain('[TaskWraith] Kimi CLI was not found.')
    manager.kill('terminal-2')
  })
})
