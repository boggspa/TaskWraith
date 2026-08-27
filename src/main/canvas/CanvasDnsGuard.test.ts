import { describe, expect, it, vi } from 'vitest'
import { assertCanvasDnsAllowed, isCanvasDnsBlocked } from './CanvasDnsGuard'

const neverResolve = vi.fn(async () => {
  throw new Error('resolver should not be called')
})

describe('CanvasDnsGuard', () => {
  it('allows literal loopback without DNS (local dev servers)', async () => {
    await expect(assertCanvasDnsAllowed('http://localhost:5173', neverResolve)).resolves.toBeUndefined()
    await expect(assertCanvasDnsAllowed('http://127.0.0.1:3000', neverResolve)).resolves.toBeUndefined()
    expect(neverResolve).not.toHaveBeenCalled()
  })

  it('allows literal private-network hosts without an origin list', async () => {
    await expect(assertCanvasDnsAllowed('http://192.168.1.1', neverResolve)).resolves.toBeUndefined()
    await expect(assertCanvasDnsAllowed('http://10.0.0.5', neverResolve)).resolves.toBeUndefined()
    expect(neverResolve).not.toHaveBeenCalled()
  })

  it('allows public hostnames resolving to public IPs', async () => {
    await expect(
      assertCanvasDnsAllowed('https://example.com/app', async () => ['93.184.216.34'])
    ).resolves.toBeUndefined()
  })

  it('allows dev aliases resolving private/loopback but blocks link-local resolution', async () => {
    await expect(
      assertCanvasDnsAllowed('https://preview.example/app', async () => ['10.0.0.5'])
    ).resolves.toBeUndefined()
    await expect(
      assertCanvasDnsAllowed('https://preview.example/app', async () => ['127.0.0.1'])
    ).resolves.toBeUndefined()
    await expect(
      assertCanvasDnsAllowed('https://preview.example/app', async () => ['169.254.169.254'])
    ).rejects.toThrow(/resolved_linklocal/)
  })

  it('blocks unresolved public hostnames', async () => {
    await expect(
      assertCanvasDnsAllowed('https://missing.example/app', async () => {
        throw new Error('ENOTFOUND')
      })
    ).rejects.toThrow(/dns_unresolved/)
    await expect(
      isCanvasDnsBlocked('https://missing.example/app', async () => {
        throw new Error('ENOTFOUND')
      })
    ).resolves.toBe(true)
  })
})
