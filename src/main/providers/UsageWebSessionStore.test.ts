import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSessionCookieStore } from './WebSessionCookieStore'
import { UsageWebSessionStore } from './UsageWebSessionStore'

function store(root: string): UsageWebSessionStore {
  return new UsageWebSessionStore(
    new WebSessionCookieStore({
      identity: {
        filename: 'usage-session.json',
        secretPurpose: 'test:usage-session:v1',
        envelopePurpose: 'test:usage-session-envelope:v1',
        providerLabel: 'Test'
      },
      userDataPath: root,
      platform: 'darwin',
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value, 'utf8'),
        decryptString: (value) => value.toString('utf8')
      }
    })
  )
}

describe('UsageWebSessionStore', () => {
  it('round-trips the encrypted cookie and normalized reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-usage-session-'))
    const subject = store(root)
    expect(
      subject.setSession({
        cookieHeader: 'session=secret',
        reading: {
          quotaUsedPercent: 0,
          planName: 'Lite Plan',
          resetAt: '2026-09-25T23:59:59Z',
          capturedAt: '2026-08-25T20:00:00Z'
        }
      }).ok
    ).toBe(true)
    expect(subject.loadSession()).toEqual({
      cookieHeader: 'session=secret',
      reading: {
        quotaUsedPercent: 0,
        planName: 'Lite Plan',
        resetAt: '2026-09-25T23:59:59.000Z',
        capturedAt: '2026-08-25T20:00:00.000Z'
      }
    })
  })

  it('rejects invalid readings instead of storing an opaque session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-usage-session-invalid-'))
    const subject = store(root)
    expect(
      subject.setSession({
        cookieHeader: 'session=secret',
        reading: { capturedAt: 'not-a-date' }
      })
    ).toMatchObject({ ok: false, error: 'invalidCookie' })
    expect(subject.getStatus().configured).toBe(false)
  })
})
