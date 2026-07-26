import { describe, expect, it } from 'vitest'
import { buildCodexStatusSnapshot } from './CodexStatusSnapshot'

describe('buildCodexStatusSnapshot', () => {
  it('marks app-server startup failures unavailable for preflight', () => {
    const snapshot = buildCodexStatusSnapshot({
      version: 'codex-cli 1.0.0',
      clientStarted: false,
      startupError: 'Codex app-server exited.'
    })
    expect(snapshot).toMatchObject({
      provider: 'codex',
      available: false,
      setupRequired: true,
      appServer: 'unavailable',
      error: 'Codex app-server exited.'
    })
  })

  it('keeps account probe failures unknown instead of claiming auth is not required', () => {
    const snapshot = buildCodexStatusSnapshot({
      version: 'codex-cli 1.0.0',
      clientStarted: true,
      accountStatus: { error: 'Rate-limit metadata failed' }
    })
    expect(snapshot.available).toBe(true)
    expect(snapshot.setupRequired).toBeUndefined()
    expect(snapshot.appServer).toBe('started')
    expect(snapshot.authState).toBe('unknown')
    expect(snapshot.error).toBe('Rate-limit metadata failed')
  })

  it('keeps an absent account response unknown', () => {
    const snapshot = buildCodexStatusSnapshot({
      version: 'codex-cli 1.0.0',
      clientStarted: true,
      accountStatus: null
    })
    expect(snapshot).toMatchObject({
      available: true,
      authState: 'unknown',
      requiresOpenaiAuth: false
    })
  })

  it('reserves not-required for an explicit successful account response', () => {
    const snapshot = buildCodexStatusSnapshot({
      version: 'codex-cli 1.0.0',
      clientStarted: true,
      accountStatus: { account: null, requiresOpenaiAuth: false }
    })
    expect(snapshot).toMatchObject({
      available: true,
      authState: 'not-required',
      requiresOpenaiAuth: false
    })
  })

  it('marks a clean private home as requiring the TaskWraith Codex sign-in', () => {
    const snapshot = buildCodexStatusSnapshot({
      version: 'codex-cli 1.0.0',
      clientStarted: true,
      accountStatus: { account: null, requiresOpenaiAuth: true }
    })
    expect(snapshot).toMatchObject({
      available: true,
      setupRequired: true,
      authState: 'missing',
      requiresOpenaiAuth: true
    })
    // Pin the SUBSTANCE, not one phrase. A user signed in to the codex CLI,
    // the web, and seeing their plan will read "sign-in required" as a
    // TaskWraith bug unless the message says why their CLI login does not
    // carry: the private home, the ~/.codex one it is NOT, and the in-app
    // route that targets the right one.
    expect(snapshot.error).toMatch(/private Codex home/i)
    expect(snapshot.error).toMatch(/~\/\.codex/)
    expect(snapshot.error).toMatch(/Settings → Providers → Codex/)
  })

  it('keeps a private-home account runnable', () => {
    const snapshot = buildCodexStatusSnapshot({
      version: 'codex-cli 1.0.0',
      clientStarted: true,
      accountStatus: {
        account: { type: 'chatgpt', planType: 'plus' },
        requiresOpenaiAuth: false
      }
    })
    expect(snapshot).toMatchObject({
      available: true,
      authState: 'chatgpt',
      planType: 'plus'
    })
    expect(snapshot.setupRequired).toBeUndefined()
  })

  it('keeps the app-server API-key account shape runnable', () => {
    const snapshot = buildCodexStatusSnapshot({
      version: 'codex-cli 1.0.0',
      clientStarted: true,
      accountStatus: {
        account: { type: 'apiKey' },
        requiresOpenaiAuth: true
      }
    })
    expect(snapshot).toMatchObject({
      available: true,
      authState: 'apiKey',
      requiresOpenaiAuth: false
    })
    expect(snapshot.setupRequired).toBeUndefined()
  })
})
