/**
 * Live Activity push tokens, keyed by the activity they can update.
 *
 * These are NOT APNs device tokens. ActivityKit issues one per activity, valid
 * only for that activity and only on the `…push-type.liveactivity` topic. They
 * are short-lived by nature: the activity ends, the token dies.
 *
 * IN MEMORY ONLY, on purpose. A token that outlives the app is worthless — the
 * activity it addresses is gone, and pushing to it just earns 410s. Persisting
 * them would trade nothing for a file full of live push credentials.
 */

export interface LiveActivityRegistration {
  pairID: string
  activityRef: string
  token: string
  env: 'production' | 'sandbox'
  /** Which thread this activity is showing. Mac-side ONLY — deliberately absent
   *  from the activity's own attributes and content-state, so the push payload
   *  carries no link back to a conversation even though we can route by one. */
  threadId?: string
  /** Workspace summary route. Mac-side ONLY and mutually exclusive with
   *  `threadId`; never copied into ActivityKit attributes/content-state. */
  workspaceId?: string
  registeredAt: number
  /** Last content-state we successfully pushed, so an unchanged projection
   *  spends no push. Compared by value. */
  lastPushedFingerprint?: string
}

/** The app-wide push-to-start token for one paired device, plus the accent
 *  table that device shipped with it. */
export interface LiveActivityStartRegistration {
  pairID: string
  token: string
  env: 'production' | 'sandbox'
  providerAccents: Record<string, number>
  registeredAt: number
}

export class LiveActivityTokenStore {
  private readonly byRef = new Map<string, LiveActivityRegistration>()
  private readonly startTokens = new Map<string, LiveActivityStartRegistration>()
  private readonly now: () => number

  /** Bounded so a misbehaving or malicious peer cannot grow this without limit.
   *  Well above the on-device concurrent-activity cap (3) times a few devices. */
  static readonly MAX_ENTRIES = 64

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? ((): number => Date.now())
  }

  private static key(pairID: string, activityRef: string): string {
    return `${pairID}\u0000${activityRef}`
  }

  register(entry: {
    pairID: string
    activityRef: string
    token: string
    env: 'production' | 'sandbox'
    threadId?: string
    workspaceId?: string
  }): void {
    const key = LiveActivityTokenStore.key(entry.pairID, entry.activityRef)
    if (!this.byRef.has(key) && this.byRef.size >= LiveActivityTokenStore.MAX_ENTRIES) {
      // Evict the oldest rather than refusing the newest: the newest is the one
      // the user is actually looking at.
      let oldestKey: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [k, v] of this.byRef) {
        if (v.registeredAt < oldestAt) {
          oldestAt = v.registeredAt
          oldestKey = k
        }
      }
      if (oldestKey) this.byRef.delete(oldestKey)
    }
    this.byRef.set(key, {
      ...entry,
      registeredAt: this.now(),
      // A rotated token addresses the same activity, but the state it has on
      // screen is unknown to us — clear the fingerprint so the next projection
      // re-pushes rather than being skipped as unchanged.
      lastPushedFingerprint: undefined
    })
  }

  /** The phone said this activity ended, or the token was revoked. */
  forget(pairID: string, activityRef: string): void {
    this.byRef.delete(LiveActivityTokenStore.key(pairID, activityRef))
  }

  /** Every registration currently showing a given thread. More than one is
   *  normal — the same chat can be open on an iPhone and an iPad. */
  forThread(threadId: string): LiveActivityRegistration[] {
    const out: LiveActivityRegistration[] = []
    for (const entry of this.byRef.values()) {
      if (entry.threadId === threadId) out.push(entry)
    }
    return out
  }

  /** Every activity currently showing an anonymous summary for a workspace. */
  forWorkspace(workspaceId: string): LiveActivityRegistration[] {
    const out: LiveActivityRegistration[] = []
    for (const entry of this.byRef.values()) {
      if (entry.workspaceId === workspaceId) out.push(entry)
    }
    return out
  }

  /** Returns false when the fingerprint is unchanged, so the caller can skip
   *  the push. Records it as pushed either way. */
  markPushed(pairID: string, activityRef: string, fingerprint: string): boolean {
    const entry = this.byRef.get(LiveActivityTokenStore.key(pairID, activityRef))
    if (!entry) return false
    if (entry.lastPushedFingerprint === fingerprint) return false
    entry.lastPushedFingerprint = fingerprint
    return true
  }

  registerStartToken(entry: {
    pairID: string
    token: string
    env: 'production' | 'sandbox'
    providerAccents: Record<string, number>
  }): void {
    this.startTokens.set(entry.pairID, { ...entry, registeredAt: this.now() })
  }

  /** Every device that can be asked to RAISE an activity. */
  startRegistrations(): LiveActivityStartRegistration[] {
    return [...this.startTokens.values()]
  }

  /** True when this device is already showing an activity for the thread, so
   *  push-starting another would give the user two cards for one run. */
  hasActivityForThread(pairID: string, threadId: string): boolean {
    for (const entry of this.byRef.values()) {
      if (entry.pairID === pairID && entry.threadId === threadId) return true
    }
    return false
  }

  hasActivityForWorkspace(pairID: string, workspaceId: string): boolean {
    for (const entry of this.byRef.values()) {
      if (entry.pairID === pairID && entry.workspaceId === workspaceId) return true
    }
    return false
  }

  /** Drop everything for a pair — unpaired, forgotten, or signed out. */
  forgetPair(pairID: string): void {
    for (const [key, entry] of this.byRef) {
      if (entry.pairID === pairID) this.byRef.delete(key)
    }
    this.startTokens.delete(pairID)
  }

  clear(): void {
    this.byRef.clear()
    this.startTokens.clear()
  }

  get size(): number {
    return this.byRef.size
  }
}
