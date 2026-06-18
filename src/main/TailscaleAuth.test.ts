import { describe, expect, it, vi } from 'vitest'
import { redactAuthKey, tailscaleUpWithAuthKey, type PreparedKeyFile } from './TailscaleAuth'

const KEY = 'tskey-auth-k7Q3xExample0123456789abcdef'

// Fake key-file prep so no real FS is touched; records cleanup.
const fakePrepare = () => {
  const cleanup = vi.fn(async () => {})
  const prepareKeyFile = vi.fn(
    async (_key: string): Promise<PreparedKeyFile> => ({ path: '/tmp/fake/key', cleanup })
  )
  return { prepareKeyFile, cleanup }
}

describe('redactAuthKey', () => {
  it('never reveals the middle of the key', () => {
    const red = redactAuthKey(KEY)
    expect(red).not.toContain('Example')
    expect(red.startsWith('tskey-')).toBe(true)
    expect(redactAuthKey('tskey-x')).toBe('tskey-***')
  })
})

describe('tailscaleUpWithAuthKey', () => {
  it('refuses without a CLI path and never touches exec or the FS', async () => {
    const exec = vi.fn()
    const { prepareKeyFile } = fakePrepare()
    const res = await tailscaleUpWithAuthKey({ cliPath: '', authKey: KEY, exec, prepareKeyFile })
    expect(res.ok).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    expect(prepareKeyFile).not.toHaveBeenCalled()
  })

  it('refuses a malformed key before writing it anywhere', async () => {
    const exec = vi.fn()
    const { prepareKeyFile } = fakePrepare()
    const res = await tailscaleUpWithAuthKey({
      cliPath: '/usr/bin/tailscale',
      authKey: 'nope',
      exec,
      prepareKeyFile
    })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/auth key/i)
    expect(exec).not.toHaveBeenCalled()
    expect(prepareKeyFile).not.toHaveBeenCalled()
  })

  it('keeps the key OFF the argv (file: path only) and cleans up', async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[]) => ({ stdout: '', stderr: '' }))
    const { prepareKeyFile, cleanup } = fakePrepare()
    const res = await tailscaleUpWithAuthKey({
      cliPath: '/usr/bin/tailscale',
      authKey: KEY,
      exec,
      prepareKeyFile
    })
    expect(res.ok).toBe(true)
    const [cmd, args] = exec.mock.calls[0]
    expect(cmd).toBe('/usr/bin/tailscale')
    expect(args).toEqual(['up', '--auth-key=file:/tmp/fake/key', '--timeout=30s'])
    expect(args.join(' ')).not.toContain(KEY) // raw key never on the command line
    expect(args).not.toContain('--accept-routes')
    expect(args).not.toContain('--reset')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('strips the key from the success message even if the CLI echoes it', async () => {
    const exec = vi.fn(async () => ({ stdout: `authenticated with ${KEY}`, stderr: '' }))
    const { prepareKeyFile } = fakePrepare()
    const res = await tailscaleUpWithAuthKey({
      cliPath: '/usr/bin/tailscale',
      authKey: KEY,
      exec,
      prepareKeyFile
    })
    expect(res.ok).toBe(true)
    expect(res.message).not.toContain(KEY)
    expect(res.message).toContain('redacted')
  })

  it('cleans up the key file and redacts even when the CLI fails', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('exit 1'), { stderr: `invalid key ${KEY}` })
    })
    const { prepareKeyFile, cleanup } = fakePrepare()
    const res = await tailscaleUpWithAuthKey({
      cliPath: '/usr/bin/tailscale',
      authKey: KEY,
      exec,
      prepareKeyFile
    })
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain(KEY)
    expect(res.message).toMatch(/invalid key/)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
