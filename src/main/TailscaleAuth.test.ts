import { describe, expect, it, vi } from 'vitest'
import {
  looksLikeTailscaleAuthKey,
  redactAuthKey,
  tailscaleUpWithAuthKey
} from './TailscaleAuth'

const KEY = 'tskey-auth-k7Q3xExample0123456789abcdef'

describe('looksLikeTailscaleAuthKey', () => {
  it('accepts tskey-… values of reasonable length', () => {
    expect(looksLikeTailscaleAuthKey(KEY)).toBe(true)
    expect(looksLikeTailscaleAuthKey('tskey-api-abcdef0123456789')).toBe(true)
    expect(looksLikeTailscaleAuthKey(`  ${KEY}  `)).toBe(true)
  })

  it('rejects non-keys and too-short values', () => {
    expect(looksLikeTailscaleAuthKey('garbage')).toBe(false)
    expect(looksLikeTailscaleAuthKey('tskey-')).toBe(false)
    expect(looksLikeTailscaleAuthKey('')).toBe(false)
    expect(looksLikeTailscaleAuthKey('   ')).toBe(false)
  })
})

describe('redactAuthKey', () => {
  it('never reveals the middle of the key', () => {
    const red = redactAuthKey(KEY)
    expect(red).not.toContain('Example')
    expect(red.startsWith('tskey-')).toBe(true)
    expect(redactAuthKey('tskey-x')).toBe('tskey-***')
  })
})

describe('tailscaleUpWithAuthKey', () => {
  it('refuses without a CLI path and never calls exec', async () => {
    const exec = vi.fn()
    const res = await tailscaleUpWithAuthKey({ cliPath: '', authKey: KEY, exec })
    expect(res.ok).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('refuses a malformed key and never calls exec', async () => {
    const exec = vi.fn()
    const res = await tailscaleUpWithAuthKey({ cliPath: '/usr/bin/tailscale', authKey: 'nope', exec })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/auth key/i)
    expect(exec).not.toHaveBeenCalled()
  })

  it('passes the key as a single --auth-key arg (no shell, minimal flags)', async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[]) => ({ stdout: '', stderr: '' }))
    const res = await tailscaleUpWithAuthKey({ cliPath: '/usr/bin/tailscale', authKey: KEY, exec })
    expect(res.ok).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
    const [cmd, args] = exec.mock.calls[0]
    expect(cmd).toBe('/usr/bin/tailscale')
    expect(args).toEqual(['up', `--auth-key=${KEY}`, '--timeout=30s'])
    // No --accept-routes / --reset / other surprises.
    expect(args).not.toContain('--accept-routes')
    expect(args).not.toContain('--reset')
  })

  it('strips the key from the success message even if the CLI echoes it', async () => {
    const exec = vi.fn(async () => ({ stdout: `authenticated with ${KEY}`, stderr: '' }))
    const res = await tailscaleUpWithAuthKey({ cliPath: '/usr/bin/tailscale', authKey: KEY, exec })
    expect(res.ok).toBe(true)
    expect(res.message).not.toContain(KEY)
    expect(res.message).toContain('redacted')
  })

  it('surfaces a redacted error when the CLI fails', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('exit 1'), { stderr: `invalid key ${KEY}` })
    })
    const res = await tailscaleUpWithAuthKey({ cliPath: '/usr/bin/tailscale', authKey: KEY, exec })
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain(KEY)
    expect(res.message).toMatch(/invalid key/)
  })
})
