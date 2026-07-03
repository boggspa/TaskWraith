import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, createPublicKey } from 'node:crypto'
import {
  exportPrivateKeyDer,
  generateIdentityKeyPair,
  importEd25519PrivateKeyDer,
  signEd25519
} from '../shared/e2ee/keys'

export interface AuditBundleSigningSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export interface AuditBundleSigningKey {
  keyId: string
  publicKeyDerBase64: string
  signPayload: (payload: Buffer) => Buffer
}

interface PersistedAuditBundleSigningKey {
  version: 1
  keyId: string
  publicKeyDerBase64: string
  createdAt: string
  encryptedPrivateKey: string
}

function keyIdForPublicKeyDer(publicKeyDer: Buffer): string {
  return `audit-ed25519:${createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32)}`
}

export class AuditBundleSigningKeyStore {
  constructor(
    private readonly path: string,
    private readonly safeStorage: AuditBundleSigningSafeStorage,
    private readonly log: (line: string) => void = () => {}
  ) {}

  loadOrCreate(): AuditBundleSigningKey | null {
    const existing = this.tryLoad()
    if (existing) return existing
    if (!this.safeStorage.isEncryptionAvailable()) {
      this.log('[audit-bundle] safeStorage unavailable — exporting unsigned audit bundle')
      return null
    }
    return this.generateAndPersist()
  }

  private tryLoad(): AuditBundleSigningKey | null {
    if (!existsSync(this.path)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as PersistedAuditBundleSigningKey
      if (parsed?.version !== 1 || !parsed.encryptedPrivateKey) {
        throw new Error('audit bundle signing key file is malformed')
      }
      const derB64 = this.safeStorage.decryptString(Buffer.from(parsed.encryptedPrivateKey, 'base64'))
      const privateKey = importEd25519PrivateKeyDer(Buffer.from(derB64, 'base64'))
      const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer
      const publicKeyDerBase64 = publicKeyDer.toString('base64')
      const keyId = keyIdForPublicKeyDer(publicKeyDer)
      if (parsed.keyId !== keyId || parsed.publicKeyDerBase64 !== publicKeyDerBase64) {
        throw new Error('audit bundle signing key metadata does not match the private key')
      }
      return {
        keyId,
        publicKeyDerBase64,
        signPayload: (payload) => signEd25519(privateKey, payload)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`[audit-bundle] failed to load signing key: ${detail}`)
      throw new Error(
        `The audit bundle signing key exists but can't be read (${detail}). ` +
          `Refusing to silently replace it because exported audit bundles rely on ` +
          `key continuity. Unlock the login keychain and relaunch, or delete ${this.path} ` +
          `only if you intentionally want a new audit signing identity.`
      )
    }
  }

  private generateAndPersist(): AuditBundleSigningKey {
    const keyPair = generateIdentityKeyPair()
    const privateKeyDer = exportPrivateKeyDer(keyPair.privateKey)
    const publicKeyDer = createPublicKey(keyPair.privateKey).export({
      type: 'spki',
      format: 'der'
    }) as Buffer
    const keyId = keyIdForPublicKeyDer(publicKeyDer)
    const publicKeyDerBase64 = publicKeyDer.toString('base64')
    const record: PersistedAuditBundleSigningKey = {
      version: 1,
      keyId,
      publicKeyDerBase64,
      createdAt: new Date().toISOString(),
      encryptedPrivateKey: this.safeStorage
        .encryptString(privateKeyDer.toString('base64'))
        .toString('base64')
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(record, null, 2), { mode: 0o600 })
    return {
      keyId,
      publicKeyDerBase64,
      signPayload: (payload) => signEd25519(keyPair.privateKey, payload)
    }
  }
}
