import {
  WebSessionCookieStore,
  type WebSessionSafeStorage,
  type WebSessionStoreIdentity
} from '../providers/WebSessionCookieStore'

/**
 * Identity + singleton for the Mistral web-session cookie envelope.
 *
 * The secret is the admin.mistral.ai console session captured by Import Web
 * Session. It feeds MistralWebSubscriptionClient, which reads the REAL
 * subscription bars (API usage + Vibe Code usage) instead of estimating them.
 * All hardening lives in WebSessionCookieStore; this module only pins the
 * identity constants that keep this file distinct from every other secret
 * store — the exact-object purpose checks make a file swapped between stores
 * read as corrupt rather than being honoured.
 */

export const MISTRAL_WEB_SESSION_FILENAME = 'mistral-web-session.json'

export const MISTRAL_WEB_SESSION_IDENTITY: WebSessionStoreIdentity = {
  filename: MISTRAL_WEB_SESSION_FILENAME,
  secretPurpose: 'taskwraith:mistral-web-session:v1',
  envelopePurpose: 'taskwraith:mistral-web-session-envelope:v1',
  providerLabel: 'Mistral'
}

export interface MistralWebSessionStoreOptions {
  readonly userDataPath: string
  readonly safeStorage: WebSessionSafeStorage
}

// ── process-wide singleton ───────────────────────────────────────────────────
// Constructed once after app-ready, when safeStorage has selected its final
// platform backend. Every accessor tolerates being called before that — the
// web-session lane is optional, so "not configured yet" must never throw.

let singleton: WebSessionCookieStore | null = null

export function configureMistralWebSessionStore(
  options: MistralWebSessionStoreOptions
): WebSessionCookieStore {
  singleton = new WebSessionCookieStore({
    identity: MISTRAL_WEB_SESSION_IDENTITY,
    userDataPath: options.userDataPath,
    safeStorage: options.safeStorage
  })
  return singleton
}

export function mistralWebSessionStore(): WebSessionCookieStore | null {
  return singleton
}
