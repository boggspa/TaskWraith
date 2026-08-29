import { useCallback, useEffect, useState, type JSX } from 'react'

import type {
  SharedJarCandidate,
  WebSiteLogin,
  WebSiteLoginAccess
} from '../../../shared/webSiteLogin'
import './WebLoginsDockPanel.css'

/**
 * Work > Logins - the sites the user has chosen to stay signed into.
 *
 * See docs/appdrive/authorized-site-sessions.md. Two things this panel must get
 * right, because they are the whole product claim:
 *
 * 1. It NEVER handles a credential. Sign in opens a window main owns; the
 *    password is typed there and TaskWraith never sees it. There is no password
 *    field anywhere in this component and there must never be one.
 * 2. The access selector is the authority control. A new site starts at "No
 *    agent access", and the row says plainly what each level means, because
 *    "Can act" means an agent acts AS THE USER in that account.
 */

interface WebLoginBridge {
  listWebSiteLogins?: () => Promise<WebSiteLogin[]>
  addWebSiteLogin?: (input: {
    origin: string
    label?: string
  }) => Promise<{ ok: boolean; error?: string; site?: WebSiteLogin }>
  updateWebSiteLogin?: (input: {
    id: string
    label?: string
    extraOrigins?: string[]
    agentAccess?: WebSiteLoginAccess
  }) => Promise<{ ok: boolean; error?: string; site?: WebSiteLogin }>
  removeWebSiteLogin?: (input: { id: string }) => Promise<{ ok: boolean; error?: string }>
  signInWebSiteLogin?: (input: { id: string }) => Promise<{
    ok: boolean
    reason?: string
    suggestedOrigins?: string[]
    site?: WebSiteLogin | null
  }>
  signOutWebSiteLogin?: (input: { id: string }) => Promise<{ ok: boolean; error?: string }>
  listWebSiteLoginMigrationCandidates?: () => Promise<SharedJarCandidate[]>
  dismissWebSiteLoginMigrationCandidate?: (input: {
    origin: string
  }) => Promise<{ ok: boolean; error?: string }>
  clearSharedBrowserData?: () => Promise<{ ok: boolean; error?: string }>
}

function bridge(): WebLoginBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return window.api as unknown as WebLoginBridge
}

const ACCESS_LABELS: Record<WebSiteLoginAccess, string> = {
  off: 'No agent access',
  read: 'Agents can read',
  act: 'Agents can act as me'
}

const ACCESS_HINTS: Record<WebSiteLoginAccess, string> = {
  off: 'Signed in for you only. No agent can open this site.',
  read: 'Agents may open and read this site. They cannot click or type.',
  act: 'Agents may act in this account, under an approved lease.'
}

const STATUS_LABELS: Record<WebSiteLogin['status'], string> = {
  never: 'Not signed in',
  'signed-in': 'Signed in',
  expired: 'Sign-in expired',
  unknown: 'Sign-in not verified'
}

export interface WebLoginsDockPanelViewProps {
  sites: WebSiteLogin[]
  origin: string
  busyId: string | null
  error: string | null
  suggestions: { id: string; origins: string[] } | null
  onOriginChange: (value: string) => void
  onAdd: () => void
  onAccessChange: (site: WebSiteLogin, access: WebSiteLoginAccess) => void
  onSignIn: (site: WebSiteLogin) => void
  onSignOut: (site: WebSiteLogin) => void
  onForget: (site: WebSiteLogin) => void
  onAcceptSuggestions: () => void
  onDismissSuggestions: () => void
  onAllowBlockedEmbeds: (site: WebSiteLogin) => void
  migrationCandidates: SharedJarCandidate[]
  onMigrate: (candidate: SharedJarCandidate) => void
  onDismissMigration: (candidate: SharedJarCandidate) => void
  onClearSharedBrowser: () => void
}

/** Pure view. There is no jsdom in this repo, so the testable surface is the
 *  markup this renders for a given state - which is also the surface the user
 *  actually reads. */
export function WebLoginsDockPanelView({
  sites,
  origin,
  busyId,
  error,
  suggestions,
  onOriginChange,
  onAdd,
  onAccessChange,
  onSignIn,
  onSignOut,
  onForget,
  onAcceptSuggestions,
  onDismissSuggestions,
  onAllowBlockedEmbeds,
  migrationCandidates,
  onMigrate,
  onDismissMigration,
  onClearSharedBrowser
}: WebLoginsDockPanelViewProps): JSX.Element {
  return (
    <section className="web-logins-dock" aria-label="Site logins">
      <header className="web-logins-dock-header">
        <div>
          <span className="web-logins-dock-eyebrow">Work</span>
          <h3>Logins</h3>
        </div>
      </header>

      <p className="web-logins-dock-intro">
        Sites you stay signed into. You sign in yourself in a separate window — TaskWraith never
        sees your password, and agents can never read or type one.
      </p>

      <div className="web-logins-add">
        <input
          type="text"
          value={origin}
          spellCheck={false}
          placeholder="example.com"
          aria-label="Site address"
          onChange={(event) => onOriginChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onAdd()
          }}
        />
        <button type="button" onClick={onAdd} disabled={!origin.trim()}>
          Add site
        </button>
      </div>

      {error && (
        <p className="web-logins-error" role="alert">
          {error}
        </p>
      )}

      {suggestions && (
        <div className="web-logins-suggestion" role="status">
          <p>
            That sign-in passed through {suggestions.origins.join(', ')}. Allow this site to
            navigate there too?
          </p>
          <div className="web-logins-suggestion-actions">
            <button type="button" onClick={onAcceptSuggestions}>
              Allow
            </button>
            <button type="button" onClick={onDismissSuggestions}>
              Not now
            </button>
          </div>
        </div>
      )}

      {migrationCandidates.length > 0 && (
        <div className="web-logins-migration" role="status">
          <p className="web-logins-migration-lead">
            You may already be signed into these in the shared browser, where every site and every
            agent share one set of cookies. Saving one here gives it a browser of its own — you sign
            in again, once.
          </p>
          <ul className="web-logins-migration-list">
            {migrationCandidates.map((candidate) => (
              <li key={candidate.origin} className="web-logins-migration-row">
                <span className="web-logins-migration-host">{candidate.host}</span>
                <div className="web-logins-migration-actions">
                  <button type="button" onClick={() => onMigrate(candidate)}>
                    Save &amp; sign in
                  </button>
                  <button type="button" onClick={() => onDismissMigration(candidate)}>
                    Not this one
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sites.length === 0 ? (
        <p className="web-logins-empty">
          No saved logins yet. Add a site to sign in once and let it stay signed in.
        </p>
      ) : (
        <ul className="web-logins-list">
          {sites.map((site) => (
            <li key={site.id} className="web-logins-row">
              <div className="web-logins-row-head">
                <span className="web-logins-row-label">{site.label}</span>
                <span className={`web-logins-status is-${site.status}`}>
                  {STATUS_LABELS[site.status]}
                </span>
              </div>
              <span className="web-logins-origin">{site.origin}</span>
              {site.extraOrigins.length > 0 && (
                <span className="web-logins-extra-origins">
                  also {site.extraOrigins.join(', ')}
                </span>
              )}
              <label className="web-logins-access">
                <span>Agent access</span>
                <select
                  value={site.agentAccess}
                  aria-label={`Agent access for ${site.label}`}
                  onChange={(event) =>
                    onAccessChange(site, event.target.value as WebSiteLoginAccess)
                  }
                >
                  {(['off', 'read', 'act'] as const).map((level) => (
                    <option key={level} value={level}>
                      {ACCESS_LABELS[level]}
                    </option>
                  ))}
                </select>
              </label>
              <span className="web-logins-access-hint">{ACCESS_HINTS[site.agentAccess]}</span>
              {site.blockedEmbedOrigins && site.blockedEmbedOrigins.length > 0 && (
                <div className="web-logins-blocked-embeds" role="status">
                  <span>
                    This site tried to embed {site.blockedEmbedOrigins.join(', ')} and it was
                    blocked. Allow it if the site needs it to work.
                  </span>
                  <button type="button" onClick={() => onAllowBlockedEmbeds(site)}>
                    Allow embeds
                  </button>
                </div>
              )}
              <div className="web-logins-row-actions">
                <button type="button" disabled={busyId === site.id} onClick={() => onSignIn(site)}>
                  Sign in
                </button>
                <button type="button" disabled={busyId === site.id} onClick={() => onSignOut(site)}>
                  Sign out
                </button>
                <button
                  type="button"
                  className="web-logins-forget"
                  disabled={busyId === site.id}
                  onClick={() => onForget(site)}
                >
                  Forget site
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {migrationCandidates.length === 0 && (
        <footer className="web-logins-dock-footer">
          <button type="button" className="web-logins-clear-shared" onClick={onClearSharedBrowser}>
            Clear the shared browser data
          </button>
          <span className="web-logins-clear-shared-hint">
            Empties the old shared cookie jar the Canvas Browser used before saved logins existed.
            Saved logins here are untouched.
          </span>
        </footer>
      )}
    </section>
  )
}

export function WebLoginsDockPanel(): JSX.Element {
  const [sites, setSites] = useState<WebSiteLogin[]>([])
  const [origin, setOrigin] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<{ id: string; origins: string[] } | null>(null)
  const [migrationCandidates, setMigrationCandidates] = useState<SharedJarCandidate[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    const api = bridge()
    if (!api?.listWebSiteLogins) return
    try {
      setSites(await api.listWebSiteLogins())
    } catch (loadError) {
      setError(String(loadError))
    }
    try {
      setMigrationCandidates((await api.listWebSiteLoginMigrationCandidates?.()) ?? [])
    } catch {
      // A jar that will not open is not worth an error banner; the offer just
      // does not appear.
      setMigrationCandidates([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Main announces a status change (a probe finding a session expired, or
    // recovering). Re-read rather than patching a row: the catalogue is
    // main-owned and this panel holds no authority over it.
    const api = bridge() as { onWebSiteLoginsChanged?: (cb: () => void) => () => void } | undefined
    const unsubscribe = api?.onWebSiteLoginsChanged?.(() => void refresh())
    return () => unsubscribe?.()
  }, [refresh])

  const handleAdd = useCallback(async (): Promise<void> => {
    const api = bridge()
    const trimmed = origin.trim()
    if (!api?.addWebSiteLogin || !trimmed) return
    setError(null)
    const result = await api.addWebSiteLogin({ origin: trimmed })
    if (!result.ok) {
      setError(result.error ?? 'Could not add that site.')
      return
    }
    setOrigin('')
    await refresh()
  }, [origin, refresh])

  const handleAccess = useCallback(
    async (site: WebSiteLogin, agentAccess: WebSiteLoginAccess): Promise<void> => {
      const api = bridge()
      if (!api?.updateWebSiteLogin) return
      setError(null)
      const result = await api.updateWebSiteLogin({ id: site.id, agentAccess })
      if (!result.ok) setError(result.error ?? 'Could not change agent access.')
      await refresh()
    },
    [refresh]
  )

  const handleSignIn = useCallback(
    async (site: WebSiteLogin): Promise<void> => {
      const api = bridge()
      if (!api?.signInWebSiteLogin) return
      setError(null)
      setBusyId(site.id)
      try {
        const result = await api.signInWebSiteLogin({ id: site.id })
        if (!result.ok) {
          setError(result.reason ?? 'Could not open a sign-in window.')
        } else if (result.suggestedOrigins && result.suggestedOrigins.length > 0) {
          setSuggestions({ id: site.id, origins: result.suggestedOrigins })
        }
      } finally {
        setBusyId(null)
        await refresh()
      }
    },
    [refresh]
  )

  const handleSignOut = useCallback(
    async (site: WebSiteLogin): Promise<void> => {
      const api = bridge()
      if (!api?.signOutWebSiteLogin) return
      setError(null)
      setBusyId(site.id)
      try {
        const result = await api.signOutWebSiteLogin({ id: site.id })
        if (!result.ok) setError(result.error ?? 'Could not sign out.')
      } finally {
        setBusyId(null)
        await refresh()
      }
    },
    [refresh]
  )

  const handleForget = useCallback(
    async (site: WebSiteLogin): Promise<void> => {
      const api = bridge()
      if (!api?.removeWebSiteLogin) return
      setError(null)
      setBusyId(site.id)
      try {
        const result = await api.removeWebSiteLogin({ id: site.id })
        if (!result.ok) setError(result.error ?? 'Could not remove that site.')
      } finally {
        setBusyId(null)
        await refresh()
      }
    },
    [refresh]
  )

  const allowBlockedEmbeds = useCallback(
    async (site: WebSiteLogin): Promise<void> => {
      const api = bridge()
      if (!api?.updateWebSiteLogin || !site.blockedEmbedOrigins?.length) return
      setError(null)
      // Widening is the user's act, and it clears the warning as a side effect:
      // an authorized origin is never recorded as blocked.
      const result = await api.updateWebSiteLogin({
        id: site.id,
        extraOrigins: [...site.extraOrigins, ...site.blockedEmbedOrigins]
      })
      if (!result.ok) setError(result.error ?? 'Could not allow those embeds.')
      await refresh()
    },
    [refresh]
  )

  /**
   * Promote one shared-jar sign-in. Adds the site, then opens the sign-in
   * window so the user authenticates INTO the new isolated jar - the cookies
   * are never copied across, which is the whole point: TaskWraith moves the
   * authority, and only the user can move the credential.
   */
  const migrate = useCallback(
    async (candidate: SharedJarCandidate): Promise<void> => {
      const api = bridge()
      if (!api?.addWebSiteLogin) return
      setBusyId(candidate.origin)
      setError(null)
      try {
        const added = await api.addWebSiteLogin({ origin: candidate.origin })
        if (!added.ok || !added.site) {
          setError(added.error ?? 'Could not save that site.')
          return
        }
        const result = await api.signInWebSiteLogin?.({ id: added.site.id })
        if (result && !result.ok && result.reason) setError(result.reason)
      } finally {
        setBusyId(null)
        await refresh()
      }
    },
    [refresh]
  )

  const dismissMigration = useCallback(
    async (candidate: SharedJarCandidate): Promise<void> => {
      const api = bridge()
      if (!api?.dismissWebSiteLoginMigrationCandidate) return
      await api.dismissWebSiteLoginMigrationCandidate({ origin: candidate.origin })
      await refresh()
    },
    [refresh]
  )

  const clearSharedBrowser = useCallback(async (): Promise<void> => {
    const api = bridge()
    if (!api?.clearSharedBrowserData) return
    setError(null)
    const result = await api.clearSharedBrowserData()
    if (!result.ok) setError(result.error ?? 'Could not clear the shared browser data.')
    await refresh()
  }, [refresh])

  const acceptSuggestions = useCallback(async (): Promise<void> => {
    const api = bridge()
    if (!api?.updateWebSiteLogin || !suggestions) return
    const site = sites.find((entry) => entry.id === suggestions.id)
    if (!site) {
      setSuggestions(null)
      return
    }
    await api.updateWebSiteLogin({
      id: site.id,
      extraOrigins: [...site.extraOrigins, ...suggestions.origins]
    })
    setSuggestions(null)
    await refresh()
  }, [refresh, sites, suggestions])

  return (
    <WebLoginsDockPanelView
      sites={sites}
      origin={origin}
      busyId={busyId}
      error={error}
      suggestions={suggestions}
      onOriginChange={setOrigin}
      onAdd={() => void handleAdd()}
      onAccessChange={(site, access) => void handleAccess(site, access)}
      onSignIn={(site) => void handleSignIn(site)}
      onSignOut={(site) => void handleSignOut(site)}
      onForget={(site) => void handleForget(site)}
      onAcceptSuggestions={() => void acceptSuggestions()}
      onDismissSuggestions={() => setSuggestions(null)}
      onAllowBlockedEmbeds={(site) => void allowBlockedEmbeds(site)}
      migrationCandidates={migrationCandidates}
      onMigrate={(candidate) => void migrate(candidate)}
      onDismissMigration={(candidate) => void dismissMigration(candidate)}
      onClearSharedBrowser={() => void clearSharedBrowser()}
    />
  )
}
