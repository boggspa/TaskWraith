import { describe, expect, it, vi } from 'vitest'
import { execTailscaleCli, tailscaleCliEnvironment } from './TailscaleCli'

describe('Tailscale CLI process environment', () => {
  it('forces CLI mode without relying on terminal environment variables', async () => {
    const processExec = vi.fn(async () => ({ stdout: '{}', stderr: '' }))

    await expect(
      execTailscaleCli(
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        ['status', '--json'],
        {
          timeoutMs: 3210,
          processEnv: { PATH: '/usr/bin' },
          processExec
        }
      )
    ).resolves.toEqual({ stdout: '{}', stderr: '' })

    expect(processExec).toHaveBeenCalledWith(
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      ['status', '--json'],
      {
        timeout: 3210,
        env: { PATH: '/usr/bin', TAILSCALE_BE_CLI: '1' }
      }
    )
  })

  it('overrides a conflicting inherited value without mutating the parent environment', () => {
    const inherited = { TAILSCALE_BE_CLI: '0', TERM: 'xterm' }

    expect(tailscaleCliEnvironment(inherited)).toEqual({
      TAILSCALE_BE_CLI: '1',
      TERM: 'xterm'
    })
    expect(inherited.TAILSCALE_BE_CLI).toBe('0')
  })
})
