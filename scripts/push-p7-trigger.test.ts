import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const triggerHarness = require('./push-p7-trigger.cjs') as {
  buildTrigger: (
    privateKey: crypto.KeyObject,
    target: string,
    input: {
      reason: string
      threadId: string
      runId: string
      taskId: string
      issuedAt: number
      nonce: string
    }
  ) => Record<string, unknown>
  decryptSafeStorageString: (encryptedBase64: string, password: string) => string
  explicitUserDataPath: (raw: string | undefined) => string
  ownerApnsConfigured: (settings: unknown) => boolean
  pairIdFromIdentityPubKey: (key: string) => string
  relayHttpBase: (url: string) => string
  sharedApnsCollapseId: (input: { reason: string; threadId: string; runId: string }) => string
  triggerSigningString: (input: Record<string, unknown>) => string
}

describe('push P7 trigger harness', () => {
  it('authors a relay-verifiable trigger without exposing private material', () => {
    const mac = crypto.generateKeyPairSync('ed25519')
    const phone = crypto.generateKeyPairSync('ed25519')
    const phoneSpki = phone.publicKey.export({ format: 'der', type: 'spki' })
    const target = phoneSpki.subarray(phoneSpki.length - 32).toString('base64')
    const trigger = triggerHarness.buildTrigger(mac.privateKey, target, {
      reason: 'runComplete',
      threadId: 'thread-1',
      runId: 'run-1',
      taskId: 'task-1',
      issuedAt: 1_700_000_000_000,
      nonce: Buffer.alloc(16, 3).toString('base64')
    })

    const sig = Buffer.from(String(trigger.sig), 'base64')
    expect(
      crypto.verify(
        null,
        Buffer.from(triggerHarness.triggerSigningString(trigger), 'utf8'),
        mac.publicKey,
        sig
      )
    ).toBe(true)
    expect(trigger.collapseId).toBe(
      triggerHarness.sharedApnsCollapseId({
        reason: 'runComplete',
        threadId: 'thread-1',
        runId: 'run-1'
      })
    )
    expect(JSON.stringify(trigger)).not.toContain('PRIVATE KEY')
    expect(triggerHarness.pairIdFromIdentityPubKey(target)).toMatch(/^iphone-[0-9a-f]{16}$/)
  })

  it('refuses a sending profile that still carries owner APNs credentials', () => {
    expect(triggerHarness.ownerApnsConfigured({})).toBe(false)
    expect(triggerHarness.ownerApnsConfigured({ apnsConfig: {} })).toBe(false)
    expect(
      triggerHarness.ownerApnsConfigured({ apnsConfig: { encryptedAuthKey: 'ciphertext' } })
    ).toBe(true)
    expect(triggerHarness.ownerApnsConfigured({ apnsConfig: { keyId: 'key' } })).toBe(true)
  })

  it('maps relay schemes without accepting embedded URL credentials', () => {
    expect(triggerHarness.relayHttpBase('wss://push.example/')).toBe('https://push.example')
    expect(triggerHarness.relayHttpBase('ws://127.0.0.1:8789')).toBe('http://127.0.0.1:8789')
    expect(() => triggerHarness.relayHttpBase('https://user:secret@push.example')).toThrow(
      /credentials/i
    )
  })

  it('requires an explicit bounded absolute sending profile', () => {
    expect(() => triggerHarness.explicitUserDataPath(undefined)).toThrow(/explicit bounded/)
    expect(() => triggerHarness.explicitUserDataPath('relative/profile')).toThrow(
      /explicit bounded/
    )
    expect(() => triggerHarness.explicitUserDataPath('/')).toThrow(/explicit bounded/)
    // explicitUserDataPath returns path.resolve(raw): on Windows a drive-relative
    // root is produced, so expect the resolved form rather than the raw literal.
    expect(triggerHarness.explicitUserDataPath('/tmp/taskwraith-p7-sender')).toBe(
      resolve('/tmp/taskwraith-p7-sender')
    )
  })

  it('decrypts Chromium macOS safeStorage v10 values without persisting the key', () => {
    const password = 'test-safe-storage-password'
    const plaintext = Buffer.from('cHJpdmF0ZS1kZXItYmFzZTY0', 'utf8')
    const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
    const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    const encrypted = Buffer.concat([
      Buffer.from('v10'),
      cipher.update(plaintext),
      cipher.final()
    ]).toString('base64')
    expect(triggerHarness.decryptSafeStorageString(encrypted, password)).toBe(
      plaintext.toString('utf8')
    )
    expect(() =>
      triggerHarness.decryptSafeStorageString(Buffer.from('bad').toString('base64'), password)
    ).toThrow(/supported macOS safeStorage/)
  })
})
