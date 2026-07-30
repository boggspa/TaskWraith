import { describe, expect, it } from 'vitest'
import {
  disableTailscaleServe,
  enableTailscaleServe,
  getTailscaleServeStatus,
  type ServeExec
} from './TailscaleServe'

const CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

function execReturning(stdout: string, stderr = ''): ServeExec {
  return async () => ({ stdout, stderr })
}

describe('getTailscaleServeStatus', () => {
  it('detects our relay-port proxy mapping (and its HTTPS port)', async () => {
    const config = JSON.stringify({
      TCP: { '443': { HTTPS: true } },
      Web: {
        'mac.tailnet.ts.net:443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } }
        }
      }
    })
    const status = await getTailscaleServeStatus({
      cliPath: CLI,
      relayPort: 8787,
      exec: execReturning(config)
    })
    expect(status).toEqual({
      configured: true,
      dnsName: 'mac.tailnet.ts.net',
      httpsPort: 443,
      proxyTarget: 'http://127.0.0.1:8787'
    })
  })

  it('reports unconfigured when serve fronts a DIFFERENT port', async () => {
    const config = JSON.stringify({
      Web: {
        'host.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } }
      }
    })
    const status = await getTailscaleServeStatus({
      cliPath: CLI,
      relayPort: 8787,
      exec: execReturning(config)
    })
    expect(status.configured).toBe(false)
  })

  it('scopes to OUR front-door port — dev (:8443) and release (:443) coexist without cross-matching', async () => {
    // One config holds BOTH builds' handlers: release :443→8787, dev :8443→8788.
    const config = JSON.stringify({
      Web: {
        'mac.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } },
        'mac.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } }
      }
    })
    // Release sees only its :443 door.
    expect(
      await getTailscaleServeStatus({
        cliPath: CLI,
        relayPort: 8787,
        httpsPort: 443,
        exec: execReturning(config)
      })
    ).toEqual({
      configured: true,
      dnsName: 'mac.tailnet.ts.net',
      httpsPort: 443,
      proxyTarget: 'http://127.0.0.1:8787'
    })
    // Dev sees only its :8443 door.
    expect(
      await getTailscaleServeStatus({
        cliPath: CLI,
        relayPort: 8788,
        httpsPort: 8443,
        exec: execReturning(config)
      })
    ).toEqual({
      configured: true,
      dnsName: 'mac.tailnet.ts.net',
      httpsPort: 8443,
      proxyTarget: 'http://127.0.0.1:8788'
    })
    // Release's relay port behind the dev front door is NOT ours → no clobbering
    // re-assert (the bug we're fixing: the loser kept healing onto the shared :443).
    expect(
      (
        await getTailscaleServeStatus({
          cliPath: CLI,
          relayPort: 8787,
          httpsPort: 8443,
          exec: execReturning(config)
        })
      ).configured
    ).toBe(false)
  })

  it('treats prose / empty output as unconfigured (no serve config)', async () => {
    expect(
      (
        await getTailscaleServeStatus({
          cliPath: CLI,
          relayPort: 8787,
          exec: execReturning('No serve config\n')
        })
      ).configured
    ).toBe(false)
    expect(
      (
        await getTailscaleServeStatus({
          cliPath: CLI,
          relayPort: 8787,
          exec: execReturning('')
        })
      ).configured
    ).toBe(false)
  })

  it('surfaces exec failures as an error, not a throw', async () => {
    const status = await getTailscaleServeStatus({
      cliPath: CLI,
      relayPort: 8787,
      exec: async () => {
        throw new Error('daemon not running')
      }
    })
    expect(status.configured).toBe(false)
    expect(status.error).toContain('daemon not running')
  })
})

describe('enableTailscaleServe', () => {
  it('runs `serve --bg --https=443 <port>` (explicit release front door) and reports ok', async () => {
    let seen: string[] = []
    const result = await enableTailscaleServe({
      cliPath: CLI,
      relayPort: 8787,
      exec: async (_cmd, args) => {
        seen = args
        return { stdout: 'Available within your tailnet:\nhttps://host.ts.net/\n', stderr: '' }
      }
    })
    expect(seen).toEqual(['serve', '--bg', '--https=443', '8787'])
    expect(result.ok).toBe(true)
  })

  it('fronts a dev build on its OWN https port (:8443) so it never clobbers release :443', async () => {
    let seen: string[] = []
    const result = await enableTailscaleServe({
      cliPath: CLI,
      relayPort: 8788,
      httpsPort: 8443,
      exec: async (_cmd, args) => {
        seen = args
        return { stdout: '', stderr: '' }
      }
    })
    expect(seen).toEqual(['serve', '--bg', '--https=8443', '8788'])
    expect(result.ok).toBe(true)
  })

  it('surfaces the CLI guidance verbatim on failure (HTTPS not enabled)', async () => {
    const result = await enableTailscaleServe({
      cliPath: CLI,
      relayPort: 8787,
      exec: async () => {
        const err = new Error('exit 1') as Error & { stderr?: string }
        err.stderr =
          'error: HTTPS is not enabled on this tailnet. Enable it at https://login.tailscale.com/admin/dns'
        throw err
      }
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('HTTPS is not enabled')
    expect(result.message).toContain('admin/dns')
  })

  /**
   * Regression: re-asserting the door used to DISARM Funnel. Plain
   * `tailscale serve` is tailnet-only, so the CLI answers `Removing Funnel for
   * <host>:<port>` and a published relay silently reverts to tailnet-only.
   * Creating a People invite calls enableTailscaleServe, so copying an invite
   * broke the very door that invite advertises — the collaborator then failed on
   * every URL with nothing on the host to explain it.
   */
  it('re-asserts a PUBLIC door with `funnel`, not `serve` (never disarms Funnel)', async () => {
    const calls: string[][] = []
    const result = await enableTailscaleServe({
      cliPath: CLI,
      relayPort: 8787,
      exec: async (_cmd, args) => {
        calls.push(args)
        if (args[0] === 'serve' && args[1] === 'status') {
          return {
            stdout: JSON.stringify({
              TCP: { '443': { HTTPS: true } },
              Web: {
                'mac.tailnet.ts.net:443': {
                  Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } }
                }
              },
              AllowFunnel: { 'mac.tailnet.ts.net:443': true }
            }),
            stderr: ''
          }
        }
        return { stdout: 'Available on the internet:\n', stderr: '' }
      }
    })
    expect(calls[calls.length - 1]).toEqual(['funnel', '--bg', '--https=443', '8787'])
    expect(result.ok).toBe(true)
  })

  it('keeps `serve` when AllowFunnel belongs to a DIFFERENT front door', async () => {
    const calls: string[][] = []
    await enableTailscaleServe({
      cliPath: CLI,
      relayPort: 8787,
      exec: async (_cmd, args) => {
        calls.push(args)
        if (args[0] === 'serve' && args[1] === 'status') {
          return {
            stdout: JSON.stringify({
              Web: {
                'mac.tailnet.ts.net:443': {
                  Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } }
                }
              },
              // Public door on someone else's port — must not make OURS public.
              AllowFunnel: { 'mac.tailnet.ts.net:8443': true }
            }),
            stderr: ''
          }
        }
        return { stdout: '', stderr: '' }
      }
    })
    expect(calls[calls.length - 1]).toEqual(['serve', '--bg', '--https=443', '8787'])
  })

  it('falls back to `serve` when the status read fails — never widens exposure', async () => {
    const calls: string[][] = []
    await enableTailscaleServe({
      cliPath: CLI,
      relayPort: 8787,
      exec: async (_cmd, args) => {
        calls.push(args)
        if (args[0] === 'serve' && args[1] === 'status') throw new Error('tailscaled not running')
        return { stdout: '', stderr: '' }
      }
    })
    expect(calls[calls.length - 1]).toEqual(['serve', '--bg', '--https=443', '8787'])
  })
})

describe('disableTailscaleServe', () => {
  it('turns off ONLY our https port mapping', async () => {
    let seen: string[] = []
    const result = await disableTailscaleServe({
      cliPath: CLI,
      httpsPort: 443,
      exec: async (_cmd, args) => {
        seen = args
        return { stdout: '', stderr: '' }
      }
    })
    expect(seen).toEqual(['serve', '--https=443', 'off'])
    expect(result.ok).toBe(true)
  })
})
