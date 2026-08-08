import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { SkillRecord, SkillScope, UpsertSkillInput } from '../../../shared/skills/SkillTypes'
import {
  getSkillsHooksSettingsApi,
  loadAllSkills,
  skillsIpcReady
} from '../lib/skillsHooksSettingsApi'
import { PillButton } from './PillButton'
import { ProviderPassthroughSettingsHost } from './ProviderPassthroughSettings'

export interface SkillsSettingsPanelProps {
  skills: SkillRecord[]
  onUpsert: (input: UpsertSkillInput & { scope: SkillScope }) => void | Promise<void>
  onDelete: (skill: SkillRecord) => void | Promise<void>
  onSetEnabled: (skill: SkillRecord, enabled: boolean) => void | Promise<void>
  onRevealRoot: (scope: SkillScope) => void | Promise<void>
  workspaceLabel?: string
  busy?: boolean
  error?: string | null
  ipcHint?: string | null
}

function scopeLabel(scope: SkillScope, workspaceLabel?: string): string {
  if (scope === 'workspace') {
    return workspaceLabel ? `Workspace · ${workspaceLabel}` : 'Workspace'
  }
  return 'User'
}

export function SkillsSettingsPanel({
  skills,
  onUpsert,
  onDelete,
  onSetEnabled,
  onRevealRoot,
  workspaceLabel,
  busy = false,
  error = null,
  ipcHint = null
}: SkillsSettingsPanelProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [createScope, setCreateScope] = useState<SkillScope>('user')
  const [formError, setFormError] = useState<string | null>(null)

  const userSkills = useMemo(() => skills.filter((skill) => skill.scope === 'user'), [skills])
  const workspaceSkills = useMemo(
    () => skills.filter((skill) => skill.scope === 'workspace'),
    [skills]
  )

  const handleCreate = useCallback(async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setFormError('Name is required.')
      return
    }
    if (createScope === 'workspace' && !workspaceLabel) {
      setFormError('Select a workspace before creating a workspace skill.')
      return
    }
    setFormError(null)
    await onUpsert({
      name: trimmedName,
      description: description.trim(),
      body,
      enabled: true,
      scope: createScope
    })
    setName('')
    setDescription('')
    setBody('')
  }, [body, createScope, description, name, onUpsert, workspaceLabel])

  const renderSkillRow = (skill: SkillRecord): React.JSX.Element => (
    <article key={`${skill.scope}:${skill.id}`} className="settings-user-mcp-row">
      <div className="settings-user-mcp-main">
        <strong>{skill.name}</strong>
        <span>{skill.description || 'No description'}</span>
        <div className="settings-mcp-server-meta">
          <span>{scopeLabel(skill.scope, workspaceLabel)}</span>
          <span>{skill.enabled ? 'enabled' : 'disabled'}</span>
          <span>{skill.id}</span>
        </div>
      </div>
      <div className="settings-user-mcp-actions">
        <label className="settings-effects-check-row" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={skill.enabled}
            disabled={busy}
            aria-label={`Enable skill ${skill.name}`}
            onChange={(event) => void onSetEnabled(skill, event.target.checked)}
          />
          <span>Enabled</span>
        </label>
        <PillButton
          size="compact"
          variant="secondary"
          disabled={busy}
          onClick={() => void onDelete(skill)}
        >
          Delete
        </PillButton>
      </div>
    </article>
  )

  return (
    <div className="settings-mcp-page settings-skills-page">
      <div className="settings-group span-all settings-mcp-overview">
        <div className="settings-mcp-header">
          <div>
            <div className="settings-section-title-row">
              <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                Skills
              </h4>
              <span className="settings-editable-pill">Library</span>
            </div>
            <p className="settings-hint">
              User and workspace skill libraries. Toggle enablement, create a simple skill, or
              reveal the on-disk root in Finder.
            </p>
          </div>
          <div className="settings-mcp-header-actions">
            <PillButton
              size="compact"
              variant="secondary"
              disabled={busy}
              onClick={() => void onRevealRoot('user')}
            >
              Reveal user root
            </PillButton>
            <PillButton
              size="compact"
              variant="secondary"
              disabled={busy || !workspaceLabel}
              onClick={() => void onRevealRoot('workspace')}
              title={
                workspaceLabel
                  ? `Reveal skills for ${workspaceLabel}`
                  : 'Select a workspace to reveal its skills root'
              }
            >
              Reveal workspace root
            </PillButton>
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
            Create skill
          </h4>
          <p className="settings-hint">Name, description, and markdown body.</p>
        </div>
        <div className="settings-user-mcp-list">
          <label className="settings-field">
            <span>Name</span>
            <input
              className="settings-input"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-skill"
              aria-label="Skill name"
            />
          </label>
          <label className="settings-field">
            <span>Description</span>
            <input
              className="settings-input"
              value={description}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="When to use this skill"
              aria-label="Skill description"
            />
          </label>
          <label className="settings-field">
            <span>Body</span>
            <textarea
              className="settings-textarea"
              value={body}
              disabled={busy}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Skill instructions (markdown)"
              aria-label="Skill body"
              rows={6}
            />
          </label>
          <div className="settings-mcp-header-actions" style={{ justifyContent: 'space-between' }}>
            <label className="settings-field" style={{ margin: 0, minWidth: 180 }}>
              <span>Scope</span>
              <select
                className="settings-select"
                value={createScope}
                disabled={busy}
                onChange={(event) => setCreateScope(event.target.value as SkillScope)}
                aria-label="Skill scope"
              >
                <option value="user">User</option>
                <option value="workspace" disabled={!workspaceLabel}>
                  Workspace{workspaceLabel ? ` · ${workspaceLabel}` : ''}
                </option>
              </select>
            </label>
            <PillButton
              size="compact"
              variant="primary"
              disabled={busy || !name.trim()}
              onClick={() => void handleCreate()}
            >
              Create skill
            </PillButton>
          </div>
        </div>
      </div>

      <div className="settings-group span-all">
        <div className="settings-mcp-section-title">
          <h4 className="sidebar-section-title" style={{ margin: 0 }}>
            User skills
          </h4>
          <p className="settings-hint">
            {userSkills.length} skill{userSkills.length === 1 ? '' : 's'}
          </p>
        </div>
        {userSkills.length === 0 ? (
          <div className="settings-audit-empty">No user skills yet.</div>
        ) : (
          <div className="settings-user-mcp-list">{userSkills.map(renderSkillRow)}</div>
        )}
      </div>

      <div className="settings-group span-all">
        <div className="settings-mcp-section-title">
          <h4 className="sidebar-section-title" style={{ margin: 0 }}>
            Workspace skills
          </h4>
          <p className="settings-hint">
            {workspaceLabel
              ? `${workspaceSkills.length} skill${workspaceSkills.length === 1 ? '' : 's'} in ${workspaceLabel}`
              : 'Select a workspace to manage workspace skills.'}
          </p>
        </div>
        {!workspaceLabel ? (
          <div className="settings-audit-empty">No workspace selected.</div>
        ) : workspaceSkills.length === 0 ? (
          <div className="settings-audit-empty">No workspace skills yet.</div>
        ) : (
          <div className="settings-user-mcp-list">{workspaceSkills.map(renderSkillRow)}</div>
        )}
      </div>
    </div>
  )
}

export interface SkillsSettingsPanelHostProps {
  workspaceId?: string | null
  workspacePath?: string | null
  workspaceLabel?: string | null
}

/**
 * Settings host — loads skills via the IPC facade (or local stub state when
 * preload methods are not yet wired).
 */
export function SkillsSettingsPanelHost({
  workspaceId = null,
  workspacePath = null,
  workspaceLabel = null
}: SkillsSettingsPanelHostProps): React.JSX.Element {
  const api = useMemo(() => getSkillsHooksSettingsApi(), [])
  const ipcReady = skillsIpcReady(api)
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!ipcReady) return
    try {
      setBusy(true)
      setError(null)
      const next = await loadAllSkills(api, workspacePath, workspaceId)
      setSkills(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, ipcReady, workspaceId, workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onUpsert = useCallback(
    async (input: UpsertSkillInput & { scope: SkillScope }) => {
      try {
        setBusy(true)
        setError(null)
        if (api?.upsertSkill) {
          // TODO(preload): ensure upsertSkill maps to skills:upsert
          await api.upsertSkill({
            ...input,
            ...(input.scope === 'workspace' && workspacePath
              ? { workspacePath, workspaceId: workspaceId ?? undefined }
              : {})
          })
          await refresh()
          return
        }
        const now = new Date().toISOString()
        const id =
          input.id?.trim() ||
          input.name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') ||
          `skill-${Date.now()}`
        const record: SkillRecord = {
          id,
          name: input.name.trim(),
          description: input.description?.trim() || '',
          body: input.body || '',
          enabled: input.enabled ?? true,
          scope: input.scope,
          updatedAt: now,
          ...(input.scope === 'workspace' && workspaceId ? { workspaceId } : {})
        }
        setSkills((prev) => {
          const others = prev.filter((skill) => !(skill.id === id && skill.scope === input.scope))
          return [...others, record]
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
    async (skill: SkillRecord) => {
      try {
        setBusy(true)
        setError(null)
        if (api?.deleteSkill) {
          await api.deleteSkill({
            scope: skill.scope,
            id: skill.id,
            ...(skill.scope === 'workspace' && workspacePath ? { workspacePath } : {})
          })
          await refresh()
          return
        }
        setSkills((prev) =>
          prev.filter((entry) => !(entry.id === skill.id && entry.scope === skill.scope))
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
    async (skill: SkillRecord, enabled: boolean) => {
      try {
        setBusy(true)
        setError(null)
        if (api?.setSkillEnabled) {
          await api.setSkillEnabled({
            scope: skill.scope,
            id: skill.id,
            enabled,
            ...(skill.scope === 'workspace' && workspacePath
              ? { workspacePath, workspaceId: workspaceId ?? undefined }
              : {})
          })
          await refresh()
          return
        }
        setSkills((prev) =>
          prev.map((entry) =>
            entry.id === skill.id && entry.scope === skill.scope
              ? { ...entry, enabled, updatedAt: new Date().toISOString() }
              : entry
          )
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [api, refresh, workspaceId, workspacePath]
  )

  const onRevealRoot = useCallback(
    async (scope: SkillScope) => {
      try {
        setError(null)
        if (api?.revealSkillsRoot) {
          // TODO(preload): ensure revealSkillsRoot maps to skills:reveal-root
          const result = await api.revealSkillsRoot({
            scope,
            ...(scope === 'workspace' && workspacePath ? { workspacePath } : {})
          })
          if (!result.ok) {
            setError(result.error || 'Could not reveal skills root.')
          }
          return
        }
        setError('Reveal skills root IPC is not wired yet.')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [api, workspacePath]
  )

  return (
    <>
      <SkillsSettingsPanel
        skills={skills}
        onUpsert={onUpsert}
        onDelete={onDelete}
        onSetEnabled={onSetEnabled}
        onRevealRoot={onRevealRoot}
        workspaceLabel={workspaceLabel ?? undefined}
        busy={busy}
        error={error}
        ipcHint={
          ipcReady
            ? null
            : 'Skills IPC is not wired in preload yet — edits stay in this session until the bridge is connected.'
        }
      />
      <ProviderPassthroughSettingsHost />
    </>
  )
}
