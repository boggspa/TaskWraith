import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  HOOK_EVENTS,
  type HookCommand,
  type HookEvent,
  type HookOnError,
  type HookScope
} from '../../../shared/hooks/HookTypes'
import {
  getSkillsHooksSettingsApi,
  hooksIpcReady,
  loadAllHooks
} from '../lib/skillsHooksSettingsApi'
import { PillButton } from './PillButton'

export interface HooksSettingsPanelProps {
  hooks: HookCommand[]
  onUpsert: (hook: HookCommand) => void | Promise<void>
  onDelete: (hook: HookCommand) => void | Promise<void>
  onSetEnabled: (hook: HookCommand, enabled: boolean) => void | Promise<void>
  workspaceLabel?: string
  busy?: boolean
  error?: string | null
  ipcHint?: string | null
}

const EVENT_LABELS: Record<HookEvent, string> = {
  SessionStart: 'Session start',
  PreToolUse: 'Pre tool use',
  PostToolUse: 'Post tool use',
  Stop: 'Stop'
}

function newHookId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function emptyDraft(event: HookEvent, scope: HookScope, workspaceId?: string): HookCommand {
  return {
    id: newHookId(),
    event,
    command: '',
    matcher: '',
    timeoutMs: 30_000,
    enabled: true,
    onError: 'continue',
    scope,
    ...(scope === 'workspace' && workspaceId ? { workspaceId } : {})
  }
}

export function HooksSettingsPanel({
  hooks,
  onUpsert,
  onDelete,
  onSetEnabled,
  workspaceLabel,
  busy = false,
  error = null,
  ipcHint = null
}: HooksSettingsPanelProps): React.JSX.Element {
  const [draftEvent, setDraftEvent] = useState<HookEvent>('SessionStart')
  const [draftScope, setDraftScope] = useState<HookScope>('user')
  const [command, setCommand] = useState('')
  const [matcher, setMatcher] = useState('')
  const [timeoutMs, setTimeoutMs] = useState(30_000)
  const [onError, setOnError] = useState<HookOnError>('continue')
  const [formError, setFormError] = useState<string | null>(null)

  const grouped = useMemo(() => {
    const map = new Map<HookEvent, HookCommand[]>()
    for (const event of HOOK_EVENTS) map.set(event, [])
    for (const hook of hooks) {
      const list = map.get(hook.event) ?? []
      list.push(hook)
      map.set(hook.event, list)
    }
    return map
  }, [hooks])

  const handleCreate = useCallback(async () => {
    const trimmed = command.trim()
    if (!trimmed) {
      setFormError('Command is required.')
      return
    }
    if (draftScope === 'workspace' && !workspaceLabel) {
      setFormError('Select a workspace before creating a workspace hook.')
      return
    }
    setFormError(null)
    const hook = emptyDraft(draftEvent, draftScope)
    await onUpsert({
      ...hook,
      command: trimmed,
      matcher: matcher.trim() || undefined,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      onError,
      enabled: true
    })
    setCommand('')
    setMatcher('')
    setTimeoutMs(30_000)
    setOnError('continue')
  }, [command, draftEvent, draftScope, matcher, onError, onUpsert, timeoutMs, workspaceLabel])

  const renderHookRow = (hook: HookCommand): React.JSX.Element => (
    <article key={`${hook.scope}:${hook.id}`} className="settings-user-mcp-row">
      <div className="settings-user-mcp-main">
        <strong>
          <code>{hook.command}</code>
        </strong>
        <span>
          {hook.matcher ? `matcher: ${hook.matcher}` : 'No matcher'}
          {typeof hook.timeoutMs === 'number' ? ` · timeout ${hook.timeoutMs}ms` : ''}
          {hook.onError ? ` · onError ${hook.onError}` : ''}
        </span>
        <div className="settings-mcp-server-meta">
          <span>{hook.scope === 'workspace' ? workspaceLabel || 'Workspace' : 'User'}</span>
          <span>{hook.enabled ? 'enabled' : 'disabled'}</span>
          <span>{hook.id}</span>
        </div>
      </div>
      <div className="settings-user-mcp-actions">
        <label className="settings-effects-check-row" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={hook.enabled}
            disabled={busy}
            aria-label={`Enable hook ${hook.id}`}
            onChange={(event) => void onSetEnabled(hook, event.target.checked)}
          />
          <span>Enabled</span>
        </label>
        <PillButton
          size="compact"
          variant="secondary"
          disabled={busy}
          onClick={() => void onDelete(hook)}
        >
          Delete
        </PillButton>
      </div>
    </article>
  )

  return (
    <div className="settings-mcp-page settings-hooks-page">
      <div className="settings-group span-all settings-mcp-overview">
        <div className="settings-mcp-header">
          <div>
            <div className="settings-section-title-row">
              <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                Hooks
              </h4>
              <span className="settings-editable-pill">Shell</span>
            </div>
            <p className="settings-hint">
              Host-mediated shell hooks grouped by lifecycle event. Configure command, matcher,
              timeout, and on-error behavior.
            </p>
          </div>
        </div>
      </div>

      {ipcHint && (
        <p className="settings-hint" role="status">
          {ipcHint}
        </p>
      )}
      {(error || formError) && (
        <div className="settings-error" role="alert">
          {formError || error}
        </div>
      )}

      <div className="settings-group span-all">
        <div className="settings-mcp-section-title">
          <h4 className="sidebar-section-title" style={{ margin: 0 }}>
            Add hook
          </h4>
          <p className="settings-hint">Creates a new command under the selected event.</p>
        </div>
        <div className="settings-user-mcp-list">
          <div
            className="settings-mcp-header-actions"
            style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}
          >
            <label className="settings-field" style={{ margin: 0, minWidth: 160 }}>
              <span>Event</span>
              <select
                className="settings-select"
                value={draftEvent}
                disabled={busy}
                onChange={(event) => setDraftEvent(event.target.value as HookEvent)}
                aria-label="Hook event"
              >
                {HOOK_EVENTS.map((event) => (
                  <option key={event} value={event}>
                    {EVENT_LABELS[event]}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field" style={{ margin: 0, minWidth: 160 }}>
              <span>Scope</span>
              <select
                className="settings-select"
                value={draftScope}
                disabled={busy}
                onChange={(event) => setDraftScope(event.target.value as HookScope)}
                aria-label="Hook scope"
              >
                <option value="user">User</option>
                <option value="workspace" disabled={!workspaceLabel}>
                  Workspace{workspaceLabel ? ` · ${workspaceLabel}` : ''}
                </option>
              </select>
            </label>
            <label className="settings-field" style={{ margin: 0, minWidth: 140 }}>
              <span>On error</span>
              <select
                className="settings-select"
                value={onError}
                disabled={busy}
                onChange={(event) => setOnError(event.target.value as HookOnError)}
                aria-label="Hook onError"
              >
                <option value="continue">continue</option>
                <option value="block">block</option>
              </select>
            </label>
            <label className="settings-field" style={{ margin: 0, minWidth: 120 }}>
              <span>Timeout (ms)</span>
              <input
                className="settings-input"
                type="number"
                min={0}
                step={1000}
                value={timeoutMs}
                disabled={busy}
                onChange={(event) => setTimeoutMs(Number(event.target.value))}
                aria-label="Hook timeout milliseconds"
              />
            </label>
          </div>
          <label className="settings-field">
            <span>Command</span>
            <input
              className="settings-input"
              value={command}
              disabled={busy}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="echo session-start"
              aria-label="Hook command"
            />
          </label>
          <label className="settings-field">
            <span>Matcher</span>
            <input
              className="settings-input"
              value={matcher}
              disabled={busy}
              onChange={(event) => setMatcher(event.target.value)}
              placeholder="Optional tool-name pattern"
              aria-label="Hook matcher"
            />
          </label>
          <div className="settings-mcp-header-actions">
            <PillButton
              size="compact"
              variant="primary"
              disabled={busy || !command.trim()}
              onClick={() => void handleCreate()}
            >
              Add hook
            </PillButton>
          </div>
        </div>
      </div>

      {HOOK_EVENTS.map((event) => {
        const eventHooks = grouped.get(event) ?? []
        return (
          <div key={event} className="settings-group span-all">
            <div className="settings-mcp-section-title">
              <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                {EVENT_LABELS[event]}
              </h4>
              <p className="settings-hint">
                {eventHooks.length} hook{eventHooks.length === 1 ? '' : 's'} · {event}
              </p>
            </div>
            {eventHooks.length === 0 ? (
              <div className="settings-audit-empty">
                No {EVENT_LABELS[event].toLowerCase()} hooks.
              </div>
            ) : (
              <div className="settings-user-mcp-list">{eventHooks.map(renderHookRow)}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export interface HooksSettingsPanelHostProps {
  workspaceId?: string | null
  workspacePath?: string | null
  workspaceLabel?: string | null
}

/**
 * Settings host — loads hooks via the IPC facade (or local stub state when
 * preload methods are not yet wired).
 */
export function HooksSettingsPanelHost({
  workspaceId = null,
  workspacePath = null,
  workspaceLabel = null
}: HooksSettingsPanelHostProps): React.JSX.Element {
  const api = useMemo(() => getSkillsHooksSettingsApi(), [])
  const ipcReady = hooksIpcReady(api)
  const [hooks, setHooks] = useState<HookCommand[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!ipcReady) return
    try {
      setBusy(true)
      setError(null)
      const next = await loadAllHooks(api, workspacePath)
      setHooks(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, ipcReady, workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onUpsert = useCallback(
    async (hook: HookCommand) => {
      try {
        setBusy(true)
        setError(null)
        if (api?.upsertHook) {
          // TODO(preload): ensure upsertHook maps to hooks:upsert
          await api.upsertHook({
            scope: hook.scope,
            hook: {
              ...hook,
              ...(hook.scope === 'workspace' && workspaceId ? { workspaceId } : {})
            },
            ...(hook.scope === 'workspace' && workspacePath ? { workspacePath } : {})
          })
          await refresh()
          return
        }
        setHooks((prev) => {
          const others = prev.filter(
            (entry) => !(entry.id === hook.id && entry.scope === hook.scope)
          )
          return [...others, hook]
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [api, refresh, workspaceId, workspacePath]
  )

  const onDelete = useCallback(
    async (hook: HookCommand) => {
      try {
        setBusy(true)
        setError(null)
        if (api?.deleteHook) {
          await api.deleteHook({
            scope: hook.scope,
            id: hook.id,
            ...(hook.scope === 'workspace' && workspacePath ? { workspacePath } : {})
          })
          await refresh()
          return
        }
        setHooks((prev) =>
          prev.filter((entry) => !(entry.id === hook.id && entry.scope === hook.scope))
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [api, refresh, workspacePath]
  )

  const onSetEnabled = useCallback(
    async (hook: HookCommand, enabled: boolean) => {
      try {
        setBusy(true)
        setError(null)
        if (api?.setHookEnabled) {
          await api.setHookEnabled({
            scope: hook.scope,
            id: hook.id,
            enabled,
            ...(hook.scope === 'workspace' && workspacePath ? { workspacePath } : {})
          })
          await refresh()
          return
        }
        setHooks((prev) =>
          prev.map((entry) =>
            entry.id === hook.id && entry.scope === hook.scope ? { ...entry, enabled } : entry
          )
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [api, refresh, workspacePath]
  )

  return (
    <HooksSettingsPanel
      hooks={hooks}
      onUpsert={onUpsert}
      onDelete={onDelete}
      onSetEnabled={onSetEnabled}
      workspaceLabel={workspaceLabel ?? undefined}
      busy={busy}
      error={error}
      ipcHint={
        ipcReady
          ? null
          : 'Hooks IPC is not wired in preload yet — edits stay in this session until the bridge is connected.'
      }
    />
  )
}
