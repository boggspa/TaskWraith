import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import {
  AuditBundleSigningKeyStore,
  type AuditBundleSigningSafeStorage
} from './AuditBundleSigningKeyStore'
import { verifyAuditBundleSnapshotSignature, signAuditBundleSnapshot } from './ProductOperations'
import { buildAuditBundleSnapshot } from './ProductOperations'

const fakeSafeStorage: AuditBundleSigningSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8').replace(/^enc:/, '')
}

const dirs: string[] = []

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-audit-key-'))
  dirs.push(dir)
  return join(dir, 'audit-bundle-signing-key.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AuditBundleSigningKeyStore', () => {
  it('generates an encrypted key and reloads the same signing identity', () => {
    const path = tempPath()
    const first = new AuditBundleSigningKeyStore(path, fakeSafeStorage).loadOrCreate()
    const second = new AuditBundleSigningKeyStore(path, fakeSafeStorage).loadOrCreate()

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second!.keyId).toBe(first!.keyId)
    expect(second!.publicKeyDerBase64).toBe(first!.publicKeyDerBase64)

    const raw = readFileSync(path, 'utf8')
    const persisted = JSON.parse(raw) as { encryptedPrivateKey: string }
    expect(Buffer.from(persisted.encryptedPrivateKey, 'base64').toString('utf8')).toMatch(/^enc:/)

    const snapshot = buildAuditBundleSnapshot({
      approvalLedger: [],
      runEvents: [],
      workspaceChanges: [],
      auditRuns: [],
      evidencePacks: [],
      messageFeedbackReceipts: [],
      externalPublishReceipts: [],
      now: '2026-07-03T00:00:02.000Z'
    })
    const signed = signAuditBundleSnapshot(snapshot, {
      keyId: second!.keyId,
      publicKeyDerBase64: second!.publicKeyDerBase64,
      signedAt: '2026-07-03T00:00:03.000Z',
      signPayload: second!.signPayload
    })
    expect(verifyAuditBundleSnapshotSignature(signed).ok).toBe(true)
  })

  it('exports unsigned when safeStorage is unavailable and no key exists', () => {
    const path = tempPath()
    const unavailable: AuditBundleSigningSafeStorage = {
      ...fakeSafeStorage,
      isEncryptionAvailable: () => false
    }
    expect(new AuditBundleSigningKeyStore(path, unavailable).loadOrCreate()).toBeNull()
  })

  it('refuses to silently replace a corrupt existing key', () => {
    const path = tempPath()
    new AuditBundleSigningKeyStore(path, fakeSafeStorage).loadOrCreate()
    writeFileSync(path, 'not json')
    expect(() => new AuditBundleSigningKeyStore(path, fakeSafeStorage).loadOrCreate()).toThrow(
      /can't be read|Refusing to silently replace/
    )
  })
})
