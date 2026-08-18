import {
  WebSessionCookieStore,
  type WebSessionSafeStorage,
  type WebSessionStoreIdentity
} from '../providers/WebSessionCookieStore'

/**
 * Identity + singleton for the Ollama web-session cookie envelope.
 *
 * The secret is the ollama.com session captured by Import Web Session. It
 * feeds OllamaWebSubscriptionClient, which reads the account's Session (5h)
 * and Weekly usage meters — numbers the local daemon and Cloud API key lanes
 * cannot see. All hardening lives in WebSessionCookieStore; this module only
 * pins the identity constants that keep this file distinct from every other
 * secret store — the exact-object purpose checks make a file swapped between
 * stores read as corrupt rather than being honoured.
 */

export const OLLAMA_WEB_SESSION_FILENAME = 'ollama-web-session.json'

export const OLLAMA_WEB_SESSION_IDENTITY: WebSessionStoreIdentity = {
  filename: OLLAMA_WEB_SESSION_FILENAME,
  secretPurpose: 'taskwraith:ollama-web-session:v1',
  envelopePurpose: 'taskwraith:ollama-web-session-envelope:v1',
  providerLabel: 'Ollama'
}

export interface OllamaWebSessionStoreOptions {
  readonly userDataPath: string
  readonly safeStorage: WebSessionSafeStorage
}

// ── process-wide singleton ───────────────────────────────────────────────────
// Constructed once after app-ready, when safeStorage has selected its final
// platform backend. Every accessor tolerates being called before that — the
// web-session lane is optional, so "not configured yet" must never throw.

let singleton: WebSessionCookieStore | null = null

export function configureOllamaWebSessionStore(
  options: OllamaWebSessionStoreOptions
): WebSessionCookieStore {
  singleton = new WebSessionCookieStore({
    identity: OLLAMA_WEB_SESSION_IDENTITY,
    userDataPath: options.userDataPath,
    safeStorage: options.safeStorage
  })
  return singleton
}

export function ollamaWebSessionStore(): WebSessionCookieStore | null {
  return singleton
}
