import { describe, expect, it, vi } from 'vitest'
import { detectTailscale } from './TailscaleDetector'

const SAMPLE_RUNNING = {
  Version: '1.56.1-tab1234',
  TailscaleIPs: ['100.64.10.20', 'fd7a:115c:a1e0::1'],
  Self: {
    HostName: 'chris-mac',
    DNSName: 'chris-mac.tail-abc.ts.net',
    TailscaleIPs: ['100.64.10.20', 'fd7a:115c:a1e0::1']
  },
  CurrentTailnet: {
    Name: 'tail-abc.ts.net',
    MagicDNSEnabled: true,
    MagicDNSSuffix: 'tail-abc.ts.net'
  },
  BackendState: 'Running'
}

const SAMPLE_NEEDS_LOGIN = {
  Version: '1.56.1',
  TailscaleIPs: [],
  Self: { HostName: 'chris-mac' },
  BackendState: 'NeedsLogin'
}

const SAMPLE_STOPPED = {
  Version: '1.56.1',
  TailscaleIPs: [],
  Self: { HostName: 'chris-mac' },
  BackendState: 'Stopped'
}

describe('detectTailscale', () => {
  it('returns available=false with a helpful reason when CLI is missing', async () => {
    const result = await detectTailscale({ cliPath: null })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('not found')
  })

  it('returns parsed status when Tailscale is running with an IP', async () => {
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({ stdout: JSON.stringify(SAMPLE_RUNNING), stderr: '' })
    })
    expect(result.available).toBe(true)
    expect(result.cliPath).toBe('/fake/tailscale')
    expect(result.version).toBe('1.56.1-tab1234')
    expect(result.tailnetIPv4).toBe('100.64.10.20')
    expect(result.tailnetIPv6).toBe('fd7a:115c:a1e0::1')
    expect(result.hostname).toBe('chris-mac')
    expect(result.dnsName).toBe('chris-mac.tail-abc.ts.net')
    expect(result.tailnetName).toBe('tail-abc.ts.net')
    expect(result.magicDNSEnabled).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('prefers the macOS app-bundled CLI when the user installed the GUI app', async () => {
    const result = await detectTailscale({
      existsFn: (path) => path === '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      whichFn: async () => '/opt/homebrew/bin/tailscale',
      execFn: async () => ({ stdout: JSON.stringify(SAMPLE_RUNNING), stderr: '' })
    })

    expect(result.available).toBe(true)
    expect(result.cliPath).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  })

  it('falls back to PATH when no known Tailscale install location exists', async () => {
    const result = await detectTailscale({
      existsFn: () => false,
      whichFn: async () => '/custom/bin/tailscale',
      execFn: async () => ({ stdout: JSON.stringify(SAMPLE_RUNNING), stderr: '' })
    })

    expect(result.available).toBe(true)
    expect(result.cliPath).toBe('/custom/bin/tailscale')
  })

  it('strips the trailing dot Tailscale appends to DNSName', async () => {
    const sample = JSON.parse(JSON.stringify(SAMPLE_RUNNING))
    sample.Self.DNSName = 'chris-mac.tail-abc.ts.net.'
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({ stdout: JSON.stringify(sample), stderr: '' })
    })
    expect(result.dnsName).toBe('chris-mac.tail-abc.ts.net')
  })

  it('falls back to CertDomains when Self.DNSName is missing', async () => {
    const sample = JSON.parse(JSON.stringify(SAMPLE_RUNNING))
    delete sample.Self.DNSName
    sample.CertDomains = ['chris-mac.tail-abc.ts.net']
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({ stdout: JSON.stringify(sample), stderr: '' })
    })
    expect(result.available).toBe(true)
    expect(result.dnsName).toBe('chris-mac.tail-abc.ts.net')
  })

  it('treats NeedsLogin as unavailable with a sign-in hint', async () => {
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({ stdout: JSON.stringify(SAMPLE_NEEDS_LOGIN), stderr: '' })
    })
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/sign in/i)
    expect(result.hostname).toBe('chris-mac')
  })

  it('treats Stopped backend as unavailable with a connect hint', async () => {
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({ stdout: JSON.stringify(SAMPLE_STOPPED), stderr: '' })
    })
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/stopped|connect/i)
  })

  it('surfaces the CLI human-readable message when stdout is not JSON-shaped', async () => {
    // Real-world: when the Tailscale daemon isn't running, the CLI
    // prints "The Tailscale daemon is not running. Run 'sudo tailscale
    // up'…" — surfacing this verbatim is more useful than
    // "Unexpected token 'T' at position 0".
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({
        stdout: "The Tailscale daemon is not running. Run 'sudo tailscale up' or open Tailscale.\n",
        stderr: ''
      })
    })
    expect(result.available).toBe(false)
    expect(result.reason).toBe(
      "The Tailscale daemon is not running. Run 'sudo tailscale up' or open Tailscale."
    )
    expect(result.reason).not.toContain('JSON parse failed')
  })

  it('retries transient macOS GUI CLI failures before reporting unavailable', async () => {
    const sleepCalls: number[] = []
    const execFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('The Tailscale GUI failed to start: Tailscale.CLIError error 3.'))
      .mockResolvedValueOnce({ stdout: JSON.stringify(SAMPLE_RUNNING), stderr: '' })

    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn,
      retryDelayMs: 15,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      }
    })

    expect(result.available).toBe(true)
    expect(result.tailnetIPv4).toBe('100.64.10.20')
    expect(execFn).toHaveBeenCalledTimes(2)
    expect(sleepCalls).toEqual([15])
  })

  it('retries transient non-JSON readiness output before reporting unavailable', async () => {
    const execFn = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'The Tailscale GUI failed to start: Tailscale.CLIError error 3.\n',
        stderr: ''
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify(SAMPLE_RUNNING), stderr: '' })

    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn,
      retryDelayMs: 0
    })

    expect(result.available).toBe(true)
    expect(execFn).toHaveBeenCalledTimes(2)
  })

  it('falls back to plain status JSON when an older CLI rejects --peers=false', async () => {
    const execFn = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('--peers=false')) {
        const err = new Error('exit 1') as Error & { stderr?: string; code?: number }
        err.stderr = 'flag provided but not defined: -peers\nUsage: tailscale status --json\n'
        err.code = 1
        throw err
      }
      return { stdout: JSON.stringify(SAMPLE_RUNNING), stderr: '' }
    })

    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn,
      retryDelayMs: 0
    })

    expect(result.available).toBe(true)
    expect(result.dnsName).toBe('chris-mac.tail-abc.ts.net')
    expect(execFn).toHaveBeenNthCalledWith(1, '/fake/tailscale', [
      'status',
      '--json',
      '--peers=false'
    ])
    expect(execFn).toHaveBeenNthCalledWith(2, '/fake/tailscale', ['status', '--json'])
  })

  it('returns the final retry failure reason when status never becomes ready', async () => {
    const execFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockRejectedValueOnce(new Error('third failure'))
      .mockRejectedValueOnce(new Error('fourth failure'))

    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn,
      retryDelayMs: 0
    })

    expect(result.available).toBe(false)
    expect(result.reason).toContain('fourth failure')
    expect(execFn).toHaveBeenCalledTimes(4)
  })

  it('truncates very long human-readable messages to 240 chars', async () => {
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({ stdout: 'X'.repeat(500), stderr: '' })
    })
    expect(result.available).toBe(false)
    expect(result.reason?.length).toBeLessThanOrEqual(240)
  })

  it('falls back to "no status output" when stdout is empty', async () => {
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({ stdout: '   \n   ', stderr: '' })
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('no status output')
  })

  it('still reports JSON parse failure when stdout LOOKS like JSON but is malformed', async () => {
    // The new short-circuit only catches stdout that doesn't even
    // start with `{`. If the CLI emits a JSON-shaped-but-broken
    // payload, the parse-failure branch is the correct surface.
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({ stdout: '{"Version": "1.56", "Self": {', stderr: '' })
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('JSON parse failed')
  })

  it('returns available=false with a CLI-invocation reason on exec failure', async () => {
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => {
        throw new Error('command not found')
      }
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('command not found')
  })

  it('prefers CLI stderr over the generic execFile message on invocation failure', async () => {
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      statusRetries: 0,
      execFn: async () => {
        const err = new Error('Command failed: /fake/tailscale status --json') as Error & {
          stderr?: string
          code?: number
        }
        err.stderr = 'The Tailscale GUI failed to start: Tailscale.CLIError error 3.\n'
        err.code = 3
        throw err
      }
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('Tailscale.CLIError error 3')
    expect(result.reason).toContain('exit 3')
    expect(result.reason).not.toContain('Command failed: /fake/tailscale')
  })

  it('handles missing Self.TailscaleIPs by falling back to top-level TailscaleIPs', async () => {
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({
        stdout: JSON.stringify({
          Version: '1.56',
          TailscaleIPs: ['100.99.0.1'],
          Self: { HostName: 'fallback-host' },
          BackendState: 'Running'
        }),
        stderr: ''
      })
    })
    expect(result.available).toBe(true)
    expect(result.tailnetIPv4).toBe('100.99.0.1')
    expect(result.hostname).toBe('fallback-host')
  })

  it('returns available=false with unknown-state reason when backend has neither Running nor a known offline state', async () => {
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => ({
        stdout: JSON.stringify({
          Version: '1.56',
          TailscaleIPs: [],
          BackendState: 'Starting'
        }),
        stderr: ''
      })
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('Starting')
  })

  it('never throws even when the exec function returns garbage', async () => {
    // Defense in depth: the public contract is "never throws".
    const result = await detectTailscale({
      cliPath: '/fake/tailscale',
      execFn: async () => {
        return { stdout: '', stderr: '' }
      }
    })
    expect(result.available).toBe(false)
  })

  it('uses provided execFn rather than the real CLI', async () => {
    let capturedCmd: string | undefined
    let capturedArgs: string[] | undefined
    const execFn = vi.fn(async (cmd: string, args: string[]) => {
      capturedCmd = cmd
      capturedArgs = args
      return { stdout: JSON.stringify(SAMPLE_RUNNING), stderr: '' }
    })
    await detectTailscale({ cliPath: '/fake/tailscale', execFn })
    expect(execFn).toHaveBeenCalledTimes(1)
    expect(capturedCmd).toBe('/fake/tailscale')
    expect(capturedArgs).toEqual(['status', '--json', '--peers=false'])
  })
})
