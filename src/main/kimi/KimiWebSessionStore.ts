import {
  WebSessionCookieStore,
  type WebSessionSafeStorage,
  type WebSessionStoreIdentity
} from '../providers/WebSessionCookieStore'

/**
 * Identity + singleton for the Kimi web-session token envelope.
 *
 * The secret is the kimi.ai web session (access + refresh tokens from
 * localStorage, captured by Import Web Session). It feeds
 * KimiWebSubscriptionClient, which reads the shared monthly membership-credit
 * meter — a number the kimi.com API-key lane cannot see. All hardening lives
 * in WebSessionCookieStore; the tokens travel inside the same encrypted
 * envelope as every other provider's cookie header. Exact-object purpose
 * checks make a file swapped between stores read as corrupt rather than being
 * honoured.
 */

export const KIMI_WEB_SESSION_FILENAME = 'kimi-web-session.json'

export const KIMI_WEB_SESSION_IDENTITY: WebSessionStoreIdentity = {
  filename: KIMI_WEB_SESSION_FILENAME,
  secretPurpose: 'taskwraith:kimi-web-session:v1',
  envelopePurpose: 'taskwraith:kimi-web-session-envelope:v1',
  providerLabel: 'Kimi'
}

export interface KimiWebSessionStoreOptions {
  readonly userDataPath: string
  readonly safeStorage: WebSessionSafeStorage
}

// ── process-wide singleton ───────────────────────────────────────────────────
// Constructed once after app-ready, when safeStorage has selected its final
// platform backend. Every accessor tolerates being called before that — the
// web-session lane is optional, so "not configured yet" must never throw.

let singleton: WebSessionCookieStore | null = null

export function configureKimiWebSessionStore(
  options: KimiWebSessionStoreOptions
): WebSessionCookieStore {
  singleton = new WebSessionCookieStore({
    identity: KIMI_WEB_SESSION_IDENTITY,
    userDataPath: options.userDataPath,
    safeStorage: options.safeStorage
  })
  return singleton
}

export function kimiWebSessionStore(): WebSessionCookieStore | null {
  return singleton
}
