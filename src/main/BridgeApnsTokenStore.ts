import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { BridgeApnsEnv } from './BridgeApnsPusher'

/**
 * BridgeApnsTokenStore — persistent map of {pairID → APNs device token}.
 *
 * Phase C5 scaffold. The real flow:
 *   - iOS companion app registers its APNs device token at startup +
 *     after each `application:didRegisterForRemoteNotificationsWithDeviceToken:`
 *     callback (token rotation is normal).
 *   - The token is shipped to the desktop via a new daemon RPC
 *     (`bridge.registerApnsToken`) that lands when the iOS app exists.
 *   - The desktop persists it here, keyed by `pairID`, alongside the
 *     environment (production vs sandbox) so DEBUG/device builds use
 *     sandbox APNs while TestFlight/App Store builds use production APNs.
 *
 * Storage shape (JSON v1):
 *   { version: 1, tokens: [{ pairID, deviceToken, env, updatedAt }] }
 *
 * Tokens are persisted in plain JSON under userData. An APNs device token
 * is not a long-lived secret (it identifies a device for push purposes,
 * not authentication), and it's already paired-with-keys via the trusted
 * device store. If a stricter posture is wanted later, this can move
 * behind Keychain alongside the pair secrets.
 */

export interface BridgeApnsTokenEntry {
  pairID: string
  deviceToken: string
  env: BridgeApnsEnv
  updatedAt: number
}

export interface BridgeApnsTokenStoreOptions {
  /** Filesystem path. When omitted, the store is in-memory (tests). */
  storagePath?: string
  now?: () => number
  log?: (line: string) => void
}

interface PersistedShape {
  version: number
  tokens: BridgeApnsTokenEntry[]
}

const SCHEMA_VERSION = 1

export class BridgeApnsTokenStore {
  private readonly tokens = new Map<string, BridgeApnsTokenEntry>()
  private readonly storagePath?: string
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(options: BridgeApnsTokenStoreOptions = {}) {
    this.storagePath = options.storagePath
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => {})
    if (this.storagePath) {
      this.loadFromDisk()
    }
  }

  size(): number {
    return this.tokens.size
  }

  /** Register or replace a device token for a pairing. Token rotation is
   * normal — the iOS OS may issue a new token at any time, and the iOS app
   * is expected to re-register. */
  upsert(pairID: string, deviceToken: string, env: BridgeApnsEnv): BridgeApnsTokenEntry {
    if (!pairID) throw new Error('BridgeApnsTokenStore: pairID is required')
    if (!deviceToken) throw new Error('BridgeApnsTokenStore: deviceToken is required')
    if (env !== 'production' && env !== 'sandbox') {
      throw new Error(`BridgeApnsTokenStore: env must be 'production' or 'sandbox' (got '${env}')`)
    }
    const entry: BridgeApnsTokenEntry = {
      pairID,
      deviceToken,
      env,
      updatedAt: this.now()
    }
    this.tokens.set(pairID, entry)
    this.persist()
    this.log(`[BridgeApnsTokenStore] upserted pairID=${pairID} env=${env}`)
    return entry
  }

  get(pairID: string): BridgeApnsTokenEntry | null {
    return this.tokens.get(pairID) ?? null
  }

  remove(pairID: string): boolean {
    const had = this.tokens.delete(pairID)
    if (had) {
      this.persist()
      this.log(`[BridgeApnsTokenStore] removed pairID=${pairID}`)
    }
    return had
  }

  list(): BridgeApnsTokenEntry[] {
    return Array.from(this.tokens.values())
  }

  clear(): void {
    if (this.tokens.size === 0) return
    this.tokens.clear()
    this.persist()
    this.log('[BridgeApnsTokenStore] cleared all tokens')
  }

  private persist(): void {
    if (!this.storagePath) return
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true })
      const data: PersistedShape = {
        version: SCHEMA_VERSION,
        tokens: Array.from(this.tokens.values())
      }
      const serialized = JSON.stringify(data, null, 2)
      const tmpPath = `${this.storagePath}.tmp`
      writeFileSync(tmpPath, serialized, 'utf-8')
      renameSync(tmpPath, this.storagePath)
    } catch (err) {
      this.log(
        `[BridgeApnsTokenStore] persist failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private loadFromDisk(): void {
    if (!this.storagePath || !existsSync(this.storagePath)) return
    try {
      const raw = readFileSync(this.storagePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!isPersistedShape(parsed) || parsed.version !== SCHEMA_VERSION) {
        this.log(
          `[BridgeApnsTokenStore] discarded malformed/unknown-version token file at ${this.storagePath}`
        )
        return
      }
      for (const entry of parsed.tokens) {
        if (isValidEntry(entry)) {
          this.tokens.set(entry.pairID, entry)
        }
      }
      this.log(`[BridgeApnsTokenStore] loaded ${this.tokens.size} tokens from ${this.storagePath}`)
    } catch (err) {
      this.log(
        `[BridgeApnsTokenStore] load failed (starting empty): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

function isPersistedShape(value: unknown): value is PersistedShape {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.version === 'number' && Array.isArray(v.tokens)
}

function isValidEntry(value: unknown): value is BridgeApnsTokenEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.pairID === 'string' &&
    typeof v.deviceToken === 'string' &&
    (v.env === 'production' || v.env === 'sandbox') &&
    typeof v.updatedAt === 'number'
  )
}
