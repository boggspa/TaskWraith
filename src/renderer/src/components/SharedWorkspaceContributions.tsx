import { useCallback, useEffect, useState } from 'react'
import type {
  SharedWorkspaceActionRequest,
  SharedWorkspaceContributionPreview,
  SharedWorkspaceOverview
} from '../../../shared/sharedWorkspace'
import './SharedWorkspaceContributions.css'

export function SharedWorkspaceContributions({
  repoPath,
  workspacePath,
  chatId
}: {
  repoPath: string
  workspacePath: string
  chatId: string
}): React.JSX.Element {
  const [overview, setOverview] = useState<SharedWorkspaceOverview | null>(null)
  const [preview, setPreview] = useState<SharedWorkspaceContributionPreview | null>(null)
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const payload = { repoPath, worktreePath: workspacePath, chatId }
  const refresh = useCallback(async () => {
    if (typeof window.api.gitSharedWorkspace !== 'function') return
    const result = await window.api.gitSharedWorkspace({
      repoPath,
      worktreePath: workspacePath,
      chatId
    })
    if (result.ok) setOverview(result.data)
    else setNotice(result.error)
  }, [repoPath, workspacePath, chatId])
  useEffect(() => {
    let active = true
    const read = async () => {
      try {
        if (typeof window.api.gitSharedWorkspace !== 'function') return
        const result = await window.api.gitSharedWorkspace({
          repoPath,
          worktreePath: workspacePath,
          chatId
        })
        if (!active) return
        if (result.ok) setOverview(result.data)
        else setNotice(result.error)
      } catch (error) {
        if (active)
          setNotice(
            error instanceof Error ? error.message : 'Contribution evidence is unavailable.'
          )
      }
    }
    void read()
    const timer = setInterval(() => {
      void read()
    }, 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [repoPath, workspacePath, chatId])

  const review = async (id: string) => {
    setBusy(true)
    setNotice('')
    try {
      const result = await window.api.gitContributionPreview({ ...payload, id })
      if (result.ok) {
        setPreview(result.data)
        setMessage('')
      } else setNotice(result.error)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Preview failed.')
    } finally {
      setBusy(false)
    }
  }
  const act = async (action: SharedWorkspaceActionRequest['action']) => {
    if (!preview) return
    setBusy(true)
    setNotice('')
    try {
      const result = await window.api.gitContributionAction({
        ...payload,
        id: preview.id,
        generation: preview.generation,
        action,
        ...(action === 'commit' ? { message } : {})
      })
      if (result.ok) {
        setPreview(null)
        setNotice(
          result.warning ||
            (action === 'commit'
              ? `Committed${result.commit ? ` ${result.commit.slice(0, 8)}` : ''}.`
              : action === 'undo'
                ? 'Contribution undone.'
                : 'Captured edits recovered.')
        )
        await refresh()
      } else setNotice(result.error || 'The contribution could not be changed.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Contribution action failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="shared-workspace-contributions" aria-label="Shared workspace contributions">
      <div className="shared-workspace-heading">
        <h3>Contributions</h3>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void refresh().catch(() => setNotice('Refresh failed.'))
          }}
        >
          Refresh
        </button>
      </div>
      <p className="shared-workspace-coverage">
        {overview?.coverage || 'Local contribution snapshots'}
      </p>
      {overview?.verification && (
        <p className={`shared-workspace-verification state-${overview.verification.state}`}>
          Last check: <strong>{overview.verification.state}</strong> ·{' '}
          {overview.verification.command}
          {overview.verification.reason && <small>{overview.verification.reason}</small>}
        </p>
      )}
      {overview?.truncated && (
        <p role="status">
          The evidence window is incomplete. Review individual snapshots before acting.
        </p>
      )}
      {overview?.contributions.length === 0 && <p>No unsettled captured contributions.</p>}
      {overview?.contributions.map((item) => (
        <div className="shared-workspace-contribution" key={item.id}>
          <div>
            <strong>
              {item.provider}
              {item.chatId === chatId ? ' · this task' : ''}
            </strong>
            <small>{item.paths.join(', ')}</small>
          </div>
          <span>
            {item.state === 'ready'
              ? `${item.editCount} edits`
              : item.state === 'changed'
                ? 'Needs review'
                : 'Interrupted'}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void review(item.id)
            }}
          >
            Review
          </button>
        </div>
      ))}
      {preview && (
        <div className="shared-workspace-preview">
          <div className="shared-workspace-heading">
            <strong>Review contribution</strong>
            <button type="button" disabled={busy} onClick={() => setPreview(null)}>
              Close
            </button>
          </div>
          {preview.reason && <p role="status">{preview.reason}</p>}
          <pre aria-label="Contribution patch">
            {preview.patch ||
              'These edits cannot be combined automatically. Their individual recovery snapshots remain available.'}
          </pre>
          {preview.state === 'ready' && (
            <>
              <label>
                Commit message
                <input
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  maxLength={10000}
                  disabled={busy}
                />
              </label>
              <div className="shared-workspace-actions">
                <button
                  type="button"
                  disabled={busy || !message.trim()}
                  onClick={() => {
                    void act('commit')
                  }}
                >
                  Commit contribution
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void act('undo')
                  }}
                >
                  Undo contribution
                </button>
              </div>
            </>
          )}
          {preview.state === 'interrupted' && (
            <button
              type="button"
              disabled={busy || !preview.patch}
              onClick={() => {
                void act('recover')
              }}
            >
              Recover captured edits
            </button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" aria-live="polite">
          {notice}
        </p>
      )}
    </section>
  )
}
