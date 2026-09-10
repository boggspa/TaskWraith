/*
 * Tier-2 gateway token table (design §6.2) — the relay's only durable state:
 * pairID×host → APNs routing entry. Deliberately NOT a copy of the Mac's
 * BridgeApnsTokenStore single-entry-per-key full-replace Map (named
 * anti-pattern in the design): entries key on (pairID, macIdentityPubKey) so
 * one phone paired to two Macs holds two rows, upserts are per-key
 * read-modify-write, and a secondary macIdentityPubKey index serves trigger
 * fan-out. Only the atomic tmp+rename persist pattern is copied.
 *
 * Contents are routing-only: token hex, env, opt-out, clocks. No content, no
 * identity pubkeys (the pairID is a one-way hash derived before storage).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface RelayApnsEntry {
  pairID: string
  macIdentityPubKey: string
  deviceTokenHex: string
  env: 'production' | 'sandbox'
  notifyFinishedTurns: boolean
  issuedAt: number
  updatedAt: number
  expiresAt: number
}

export interface ApnsTokenTableOptions {
  /** Empty string = memory-only (tests, keyless deployments). */
  path: string
  /** Days-long by design — an APNs registration outlives any resolve TTL. */
  ttlMs?: number
  now?: () => number
  log?: (line: string) => void
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

function entryKey(pairID: string, macIdentityPubKey: string): string {
  return `${pairID}\u0000${macIdentityPubKey}`
}

export class ApnsTokenTable {
  private readonly entries = new Map<string, RelayApnsEntry>()
  /** macIdentityPubKey → entry keys, for trigger fan-out. */
  private readonly byMac = new Map<string, Set<string>>()
  private readonly path: string
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(options: ApnsTokenTableOptions) {
    this.path = options.path
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((): void => {})
    this.load()
  }

  private load(): void {
    if (!this.path) return
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return // Absent file = empty table; first persist creates it.
    }
    try {
      const parsed = JSON.parse(raw) as { entries?: unknown }
      if (!Array.isArray(parsed.entries)) return
      for (const candidate of parsed.entries) {
        if (!candidate || typeof candidate !== 'object') continue
        const entry = candidate as RelayApnsEntry
        if (
          typeof entry.pairID !== 'string' ||
          typeof entry.macIdentityPubKey !== 'string' ||
          typeof entry.deviceTokenHex !== 'string' ||
          (entry.env !== 'production' && entry.env !== 'sandbox')
        ) {
          continue
        }
        this.index({
          ...entry,
          notifyFinishedTurns:
            typeof entry.notifyFinishedTurns === 'boolean' ? entry.notifyFinishedTurns : true,
          issuedAt: Number(entry.issuedAt) || 0,
          updatedAt: Number(entry.updatedAt) || 0,
          expiresAt: Number(entry.expiresAt) || 0
        })
      }
    } catch {
      // A corrupt table must not down the relay; it degrades to empty and
      // phones re-register on their half-life timer.
      this.log('[apns-table] unreadable table ignored; starting empty')
    }
  }

  private index(entry: RelayApnsEntry): void {
    const key = entryKey(entry.pairID, entry.macIdentityPubKey)
    this.entries.set(key, entry)
    let set = this.byMac.get(entry.macIdentityPubKey)
    if (!set) {
      set = new Set()
      this.byMac.set(entry.macIdentityPubKey, set)
    }
    set.add(key)
  }

  private drop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    const set = this.byMac.get(entry.macIdentityPubKey)
    set?.delete(key)
    if (set && set.size === 0) this.byMac.delete(entry.macIdentityPubKey)
  }

  /**
   * Existing live entry for per-pairID×host issuedAt monotonicity (409 on replay).
   * Expiry-swept lazily like listForMac: an expired entry reads as absent (and is
   * reaped) so the push-delivery path never sends to a dead registration.
   */
  get(pairID: string, macIdentityPubKey: string): RelayApnsEntry | undefined {
    this.sweep()
    return this.entries.get(entryKey(pairID, macIdentityPubKey))
  }

  upsert(entry: Omit<RelayApnsEntry, 'updatedAt' | 'expiresAt'>): RelayApnsEntry {
    const stamped: RelayApnsEntry = {
      ...entry,
      updatedAt: this.now(),
      expiresAt: this.now() + this.ttlMs
    }
    this.index(stamped)
    this.persist()
    return stamped
  }

  deregister(pairID: string, macIdentityPubKey: string): boolean {
    const key = entryKey(pairID, macIdentityPubKey)
    const existed = this.entries.has(key)
    this.drop(key)
    if (existed) this.persist()
    return existed
  }

  /** Live entries for one Mac, expiry-swept lazily. */
  listForMac(macIdentityPubKey: string): RelayApnsEntry[] {
    this.sweep()
    const keys = this.byMac.get(macIdentityPubKey)
    if (!keys) return []
    const out: RelayApnsEntry[] = []
    for (const key of keys) {
      const entry = this.entries.get(key)
      if (entry) out.push(entry)
    }
    return out
  }

  /**
   * Reap on Apple's authoritative 410 Unregistered ONLY. BadDeviceToken is a
   * SOFT signal here by design divergence from Tier-1 (§6.4): both Apple
   * gateways answer it for the other env's token, so deleting on it kills a
   * live registration — log and keep.
   */
  reapUnregistered(pairID: string, macIdentityPubKey: string): void {
    const key = entryKey(pairID, macIdentityPubKey)
    if (!this.entries.has(key)) return
    this.log(`[apns-table] reaped unregistered pair ${pairID.slice(0, 14)}…`)
    this.drop(key)
    this.persist()
  }

  sweep(nowMs = this.now()): void {
    let dirty = false
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > 0 && entry.expiresAt <= nowMs) {
        this.drop(key)
        dirty = true
      }
    }
    if (dirty) this.persist()
  }

  size(): number {
    return this.entries.size
  }

  private persist(): void {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ v: 1, entries: [...this.entries.values()] }), 'utf8')
      renameSync(tmp, this.path)
    } catch (error) {
      // Persistence failure degrades to memory-only — phones re-register.
      this.log(
        `[apns-table] persist failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
