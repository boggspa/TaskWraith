/*
 * ProviderAccountsSection — the "Accounts" block of a provider's Settings
 * pane: the primary sign-in plus any secondary accounts (Settings → Providers
 * → Claude / Codex). Mirrors Provider Hub's CliAccountsSection: an active
 * picker, one row per account with its status dot, editable label, folder,
 * sign-in and remove, and an add form.
 *
 * Pure view (`ProviderAccountsSectionView`, SSR-testable) plus a thin shell
 * that talks to the preload bridge. Labels and folders are the only data that
 * cross this surface — credentials stay in main and the CLI's own stores.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ProviderAccountProviderId } from '../../../main/store/types'
import type { ProviderAccountSummary } from '../../../main/providers/ProviderAccounts'
import { PillButton } from './PillButton'
import './ProviderAccountsSection.css'

export const PROVIDER_ACCOUNT_LABEL_MAX_LENGTH = 40

type AuthStateMap = Readonly<Record<string, string | undefined>>

export interface ProviderAccountsSectionViewProps {
  provider: ProviderAccountProviderId
  accounts: readonly ProviderAccountSummary[]
  /** `claude auth status` / auth.json presence per account id; absent = not probed yet. */
  authStates: AuthStateMap
  busy: boolean
  error: string | null
  showAddForm: boolean
  draftLabel: string
  draftConfigDir: string
  onToggleAddForm: () => void
  onDraftLabelChange: (value: string) => void
  onDraftConfigDirChange: (value: string) => void
  onPickFolder: () => void
  onAdd: () => void
  onRename: (accountId: string, label: string) => void
  onRemove: (accountId: string) => void
  onSetActive: (accountId: string | null) => void
  onSignIn: (accountId: string) => void
}

export function primaryAccountLabel(provider: ProviderAccountProviderId): string {
  return provider === 'codex' ? 'Primary (TaskWraith home)' : 'Primary (~/.claude)'
}

export function accountStatusVariant(authState: string | undefined): {
  dot: 'signed-in' | 'partial' | 'not-signed-in'
  text: string
} {
  const state = (authState || '').toLowerCase()
  if (!state || state === 'unknown') return { dot: 'partial', text: 'Not checked' }
  if (state === 'authenticated' || state === 'api-key')
    return { dot: 'signed-in', text: 'Signed in' }
  return { dot: 'not-signed-in', text: 'Not signed in' }
}

export function providerAccountsCaption(provider: ProviderAccountProviderId): string {
  return provider === 'codex'
    ? 'Each extra account is a private Codex home TaskWraith creates, signed in with its own `codex login`. Its meters join Model Usage; seats keep running from the primary home for now.'
    : 'Each extra account is a folder Claude Code signs in to (CLAUDE_CONFIG_DIR). Sign in opens Terminal on the CLI’s own browser login; the active account is the one new Claude seats launch with, and its meters join Model Usage.'
}

export function ProviderAccountsSectionView({
  provider,
  accounts,
  authStates,
  busy,
  error,
  showAddForm,
  draftLabel,
  draftConfigDir,
  onToggleAddForm,
  onDraftLabelChange,
  onDraftConfigDirChange,
  onPickFolder,
  onAdd,
  onRename,
  onRemove,
  onSetActive,
  onSignIn
}: ProviderAccountsSectionViewProps): ReactElement {
  const activeId = accounts.find((account) => account.active)?.id ?? ''
  const needsFolder = provider === 'claude'
  const canAdd = draftLabel.trim().length > 0 && (!needsFolder || draftConfigDir.trim().length > 0)
  return (
    <section
      className="settings-provider-accounts"
      data-provider={provider}
      aria-label={`${provider === 'codex' ? 'Codex' : 'Claude'} accounts`}
    >
      <div className="settings-provider-accounts-header">
        <span className="settings-provider-accounts-title">
          Accounts <span>({accounts.length + 1})</span>
        </span>
        <PillButton size="compact" variant="secondary" onClick={onToggleAddForm} disabled={busy}>
          {showAddForm ? 'Cancel' : 'Add account…'}
        </PillButton>
      </div>

      <label className="settings-provider-accounts-active">
        <span>Active account</span>
        <select
          className="settings-select"
          value={activeId}
          disabled={busy}
          onChange={(event) => onSetActive(event.target.value || null)}
          aria-label="Active account"
        >
          <option value="">{primaryAccountLabel(provider)}</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </select>
      </label>

      {accounts.length > 0 ? (
        <ul className="settings-provider-accounts-list">
          {accounts.map((account) => {
            const status = accountStatusVariant(authStates[account.id])
            return (
              <li
                key={account.id}
                className={`settings-provider-accounts-row${account.active ? ' is-active' : ''}`}
                data-account-id={account.id}
              >
                <span
                  className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${status.dot}`}
                  aria-hidden
                />
                <input
                  className="settings-select settings-provider-accounts-label"
                  type="text"
                  maxLength={PROVIDER_ACCOUNT_LABEL_MAX_LENGTH}
                  defaultValue={account.label}
                  aria-label={`${account.label} account label`}
                  disabled={busy}
                  onBlur={(event) => {
                    const next = event.target.value.trim()
                    if (next && next !== account.label) onRename(account.id, next)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                  }}
                />
                <code className="settings-provider-accounts-folder" title={account.configDir}>
                  {account.configDir}
                </code>
                <span className="settings-provider-accounts-status">{status.text}</span>
                {account.active ? (
                  <span className="settings-provider-accounts-active-chip">active</span>
                ) : null}
                <PillButton
                  size="compact"
                  variant="primary"
                  disabled={busy}
                  onClick={() => onSignIn(account.id)}
                >
                  Sign in…
                </PillButton>
                <PillButton
                  size="compact"
                  variant="danger"
                  disabled={busy}
                  onClick={() => onRemove(account.id)}
                  title={
                    provider === 'codex'
                      ? 'Forget this account. Its private home stays on disk until you delete it.'
                      : 'Forget this account. The folder and its login are left as they are.'
                  }
                  aria-label={`Remove ${account.label}`}
                >
                  −
                </PillButton>
              </li>
            )
          })}
        </ul>
      ) : null}

      {showAddForm ? (
        <div className="settings-provider-accounts-add">
          <input
            className="settings-select"
            type="text"
            placeholder="Label, e.g. Work"
            maxLength={PROVIDER_ACCOUNT_LABEL_MAX_LENGTH}
            value={draftLabel}
            disabled={busy}
            aria-label="New account label"
            onChange={(event) => onDraftLabelChange(event.target.value)}
          />
          {needsFolder ? (
            <>
              <input
                className="settings-select"
                type="text"
                placeholder="~/.claude-work"
                value={draftConfigDir}
                disabled={busy}
                aria-label="New account config folder"
                onChange={(event) => onDraftConfigDirChange(event.target.value)}
              />
              <PillButton size="compact" variant="secondary" onClick={onPickFolder} disabled={busy}>
                Choose…
              </PillButton>
            </>
          ) : null}
          <PillButton size="compact" variant="primary" onClick={onAdd} disabled={busy || !canAdd}>
            Add
          </PillButton>
        </div>
      ) : null}

      {error ? <p className="settings-provider-auth-error">{error}</p> : null}
      <p className="settings-provider-auth-footnote">{providerAccountsCaption(provider)}</p>
    </section>
  )
}

export interface ProviderAccountsSectionProps {
  provider: ProviderAccountProviderId
  /** Bumped by the parent after a sign-in terminal closes, to re-probe status. */
  refreshKey?: number
}

/** Shell: owns the bridge calls and the add-form drafts. */
export function ProviderAccountsSection({
  provider,
  refreshKey = 0
}: ProviderAccountsSectionProps): ReactElement | null {
  const [accounts, setAccounts] = useState<ProviderAccountSummary[]>([])
  const [authStates, setAuthStates] = useState<Record<string, string | undefined>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftConfigDir, setDraftConfigDir] = useState('')

  const api = typeof window === 'undefined' ? undefined : window.api
  const bridgeAvailable = typeof api?.listProviderAccounts === 'function'

  const refresh = useCallback(async () => {
    if (!api || typeof api.listProviderAccounts !== 'function') return
    try {
      const listed = await api.listProviderAccounts(provider)
      const next = Array.isArray(listed) ? listed : []
      setAccounts(next)
      if (typeof api.getProviderAccountAuthState !== 'function') return
      const states = await Promise.all(
        next.map((account) =>
          api
            .getProviderAccountAuthState(account.id)
            .then((state) => [account.id, state?.authState] as const)
            .catch(() => [account.id, undefined] as const)
        )
      )
      setAuthStates(Object.fromEntries(states))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load provider accounts.')
    }
  }, [api, provider])

  useEffect(() => {
    if (!bridgeAvailable) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
    }
  }, [bridgeAvailable, refresh, refreshKey])

  const run = useCallback(
    async (action: () => Promise<{ ok: boolean; error?: string } | null | undefined>) => {
      setBusy(true)
      setError(null)
      try {
        const result = await action()
        if (result && result.ok === false) setError(result.error || 'That did not work.')
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That did not work.')
      } finally {
        setBusy(false)
        void refresh()
      }
    },
    [refresh]
  )

  if (!bridgeAvailable) return null

  return (
    <ProviderAccountsSectionView
      provider={provider}
      accounts={accounts}
      authStates={authStates}
      busy={busy}
      error={error}
      showAddForm={showAddForm}
      draftLabel={draftLabel}
      draftConfigDir={draftConfigDir}
      onToggleAddForm={() => {
        setShowAddForm((current) => !current)
        setError(null)
      }}
      onDraftLabelChange={setDraftLabel}
      onDraftConfigDirChange={setDraftConfigDir}
      onPickFolder={() => {
        if (typeof api?.pickProviderAccountConfigDir !== 'function') return
        void api
          .pickProviderAccountConfigDir()
          .then((picked) => {
            if (picked) setDraftConfigDir(picked)
          })
          .catch(() => {})
      }}
      onAdd={() =>
        void run(async () => {
          const result = await api!.addProviderAccount({
            provider,
            label: draftLabel,
            ...(provider === 'claude' ? { configDir: draftConfigDir } : {})
          })
          if (result.ok) {
            setShowAddForm(false)
            setDraftLabel('')
            setDraftConfigDir('')
          }
          return result
        })
      }
      onRename={(accountId, label) =>
        void run(() => api!.updateProviderAccount({ id: accountId, label }))
      }
      onRemove={(accountId) => void run(() => api!.removeProviderAccount(accountId))}
      onSetActive={(accountId) =>
        void run(() => api!.setActiveProviderAccount({ provider, accountId }))
      }
      onSignIn={(accountId) => void run(() => api!.openProviderAccountLoginTerminal(accountId))}
    />
  )
}
