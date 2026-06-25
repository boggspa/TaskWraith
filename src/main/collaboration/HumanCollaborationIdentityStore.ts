import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createPublicKey } from 'crypto'
import {
  exportPrivateKeyDer,
  generateIdentityKeyPair,
  importEd25519PrivateKeyDer,
  type KeyPair
} from '../../shared/e2ee/keys'

export interface HumanCollaborationSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}
interface PersistedHumanCollaborationIdentity {
  version: 1
  encryptedKey: string
}

export class HumanCollaborationIdentityStore {
  constructor(
    private readonly path: string,
    private readonly safeStorage: HumanCollaborationSafeStorage,
    private readonly log: (line: string) => void = () => {}
  ) {}

  load(): KeyPair {
    const existing = this.tryLoad()
    if (existing) return existing
    return this.generateAndPersist()
  }

  private tryLoad(): KeyPair | null {
    if (!existsSync(this.path)) return null
    try {
      const parsed = JSON.parse(
        readFileSync(this.path, 'utf8')
      ) as PersistedHumanCollaborationIdentity
      if (!parsed?.encryptedKey) throw new Error('identity file is malformed')
      const derB64 = this.safeStorage.decryptString(Buffer.from(parsed.encryptedKey, 'base64'))
      const privateKey = importEd25519PrivateKeyDer(Buffer.from(derB64, 'base64'))
      return { privateKey, publicKey: createPublicKey(privateKey) }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.log(`[human-collaboration] failed to load identity: ${detail}`)
      throw new Error(
        `The human collaboration identity key exists but cannot be read (${detail}). ` +
          `Refusing to silently replace it because collaborators pin this key.`
      )
    }
  }

  private generateAndPersist(): KeyPair {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'macOS keychain encryption (safeStorage) is unavailable, so a human collaboration ' +
          'identity key cannot be stored safely.'
      )
    }
    const keyPair = generateIdentityKeyPair()
    try {
      const derB64 = exportPrivateKeyDer(keyPair.privateKey).toString('base64')
      const encryptedKey = this.safeStorage.encryptString(derB64).toString('base64')
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(
        this.path,
        JSON.stringify(
          { version: 1, encryptedKey } satisfies PersistedHumanCollaborationIdentity,
          null,
          2
        ),
        { mode: 0o600 }
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.log(`[human-collaboration] failed to persist identity: ${detail}`)
      throw new Error(
        `A new human collaboration identity key was generated but could not be saved (${detail}).`
      )
    }
    return keyPair
  }
}
