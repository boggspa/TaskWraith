import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ResolvedInstructionContext,
  ResolvedInstructionLayer
} from '../../../shared/instructions/InstructionTypes'
import {
  INSTRUCTION_LAYER_MAX_BYTES,
  WORKSPACE_INSTRUCTIONS_FILE
} from '../../../shared/instructions/InstructionTypes'
import { PillButton } from './PillButton'

export interface InstructionsSettingsPanelHostProps {
  workspaceId: string | null
  workspacePath: string | null
  workspaceLabel: string | null
}

const SKIP_REASON_COPY: Record<string, string> = {
  too_large: `larger than ${Math.floor(INSTRUCTION_LAYER_MAX_BYTES / 1024)} KiB — skipped whole (never truncated)`,
  invalid_utf8: 'not valid UTF-8',
  unsafe_characters: 'contains bidi-override or control characters (refused, not stripped)',
  symlink_refused: 'is a symlink (refused)',
  outside_workspace: 'resolves outside the workspace root',
  unreadable: 'could not be read',
  conversational_turn: 'withheld on conversational turns'
}

function layerStatusCopy(layer: ResolvedInstructionLayer): string {
  switch (layer.status) {
    case 'applied':
      return `applied (${layer.bytes ?? 0} bytes)`
    case 'absent':
      return 'not set'
    case 'disabled':
      return 'disabled'
    case 'skipped':
      return `skipped — ${SKIP_REASON_COPY[layer.skipReason || ''] || layer.skipReason || 'skipped'}`
  }
}

/**
 * Settings → Custom Instructions.
 *
 * Edits the user-owned GLOBAL markdown document (a standalone file under the
 * app's data directory, via `instructions:*` IPC — never the settings JSON)
 * and shows the honest per-layer resolution status a run would see right
 * now, including the current workspace's TASKWRAITH.md. Fully self-contained
 * like SkillsSettingsPanelHost: reads/writes the enable toggle through
 * window.api settings calls directly.
 */
export function InstructionsSettingsPanelHost({
  workspacePath,
  workspaceLabel
}: InstructionsSettingsPanelHostProps): React.JSX.Element {
  const ipcReady =
    typeof window !== 'undefined' &&
    typeof window.api?.getGlobalInstructions === 'function' &&
    typeof window.api?.setGlobalInstructions === 'function'

  const [draft, setDraft] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [status, setStatus] = useState<ResolvedInstructionContext | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    if (typeof window.api?.resolveInstructionStatus !== 'function') return
    try {
      const resolved = await window.api.resolveInstructionStatus(
        workspacePath ? { workspacePath } : {}
      )
      setStatus(resolved)
    } catch {
      setStatus(null)
    }
  }, [workspacePath])

  useEffect(() => {
    if (!ipcReady) return
    let cancelled = false
    void (async () => {
      try {
        const doc = await window.api.getGlobalInstructions()
        if (cancelled) return
        setDraft(doc.content)
        setSavedContent(doc.content)
        setUpdatedAt(doc.updatedAt)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load instructions.')
        }
      }
      try {
        const settings = await window.api.getSettings()
        if (!cancelled) setEnabled(settings?.customInstructionsEnabled !== false)
      } catch {
        /* toggle stays optimistic-true */
      }
      await refreshStatus()
    })()
    return () => {
      cancelled = true
    }
  }, [ipcReady, refreshStatus])

  const dirty = draft !== savedContent
  const draftBytes = useMemo(() => new TextEncoder().encode(draft).length, [draft])
  const overCap = draftBytes > INSTRUCTION_LAYER_MAX_BYTES

  const handleSave = useCallback(async () => {
    if (!ipcReady || overCap) return
    setBusy(true)
    setError(null)
    setSaveNotice(null)
    try {
      const written = await window.api.setGlobalInstructions({ content: draft })
      setSavedContent(written.content)
      setUpdatedAt(written.updatedAt)
      setSaveNotice(
        'Saved. Applies from the next run; sessions that already carry instructions receive a replacement block on their next turn.'
      )
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save instructions.')
    } finally {
      setBusy(false)
    }
  }, [draft, ipcReady, overCap, refreshStatus])

  const handleToggle = useCallback(
    (next: boolean) => {
      setEnabled(next)
      if (typeof window.api?.updateSettings === 'function') {
        void window.api
          .updateSettings({ customInstructionsEnabled: next })
          .then(() => refreshStatus())
          .catch(() => setEnabled(!next))
      }
    },
    [refreshStatus]
  )

  const globalLayer = status?.layers.find((layer) => layer.scope === 'global')
  const workspaceLayer = status?.layers.find((layer) => layer.scope === 'workspace')

  return (
    <div className="settings-mcp-page settings-instructions-page">
      <div className="settings-group span-all settings-mcp-overview">
        <div className="settings-mcp-header">
          <div>
            <div className="settings-section-title-row">
              <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                Custom Instructions
              </h4>
              <span className="settings-editable-pill">Prompt layers</span>
            </div>
            <p className="settings-mcp-subtitle">
              Standing preferences injected into every composed run: this global document, then the
              current workspace&apos;s {WORKSPACE_INSTRUCTIONS_FILE}. Workspace instructions
              override global ones where they conflict; your explicit request always overrides both.
              Instructions can never grant permissions, enable tools, or change approval posture.
              The Prompt tab in the run Inspector shows exactly which layers each run received.
            </p>
          </div>
          <label className="settings-effects-check-row" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || !ipcReady}
              aria-label="Apply custom instructions to runs"
              onChange={(event) => handleToggle(event.target.checked)}
            />
            <span>Apply to runs</span>
          </label>
        </div>
        {!ipcReady && (
          <p className="settings-mcp-subtitle">
            Custom-instruction IPC is unavailable in this build; restart TaskWraith after updating.
          </p>
        )}
      </div>

      <div className="settings-group span-all">
        <label htmlFor="instructions-global-editor" className="settings-field-label">
          Global instructions (markdown)
        </label>
        <textarea
          id="instructions-global-editor"
          className="settings-textarea"
          rows={12}
          value={draft}
          disabled={busy || !ipcReady}
          placeholder={
            '# My standing preferences\n\nExample: Always answer in British English. Prefer small, reviewable commits.'
          }
          onChange={(event) => {
            setDraft(event.target.value)
            setSaveNotice(null)
          }}
        />
        <div className="settings-mcp-server-meta">
          <span>
            {draftBytes.toLocaleString()} / {INSTRUCTION_LAYER_MAX_BYTES.toLocaleString()} bytes
          </span>
          {updatedAt && <span>Last saved {new Date(updatedAt).toLocaleString()}</span>}
          {overCap && (
            <span style={{ color: 'var(--danger)' }}>
              Over the size cap — an oversized layer is skipped whole, never truncated.
            </span>
          )}
        </div>
        <div className="settings-user-mcp-actions" style={{ marginTop: 'var(--space-sm)' }}>
          <PillButton
            size="compact"
            disabled={busy || !ipcReady || !dirty || overCap}
            onClick={() => void handleSave()}
          >
            {busy ? 'Saving…' : 'Save'}
          </PillButton>
          {dirty && !busy && (
            <PillButton size="compact" variant="secondary" onClick={() => setDraft(savedContent)}>
              Discard changes
            </PillButton>
          )}
        </div>
        {saveNotice && <p className="settings-mcp-subtitle">{saveNotice}</p>}
        {error && (
          <p className="settings-mcp-subtitle" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
      </div>

      <div className="settings-group span-all">
        <div className="settings-section-title-row">
          <h4 className="sidebar-section-title" style={{ margin: 0 }}>
            What a run would receive now
          </h4>
        </div>
        <div className="settings-mcp-server-meta">
          <span>Global: {globalLayer ? layerStatusCopy(globalLayer) : 'unavailable'}</span>
        </div>
        <div className="settings-mcp-server-meta">
          <span>
            Workspace ({workspaceLabel || 'no workspace selected'}):{' '}
            {workspacePath
              ? workspaceLayer
                ? layerStatusCopy(workspaceLayer)
                : 'unavailable'
              : 'select a workspace chat to include a workspace layer'}
          </span>
        </div>
        {workspacePath && workspaceLayer?.status === 'absent' && (
          <p className="settings-mcp-subtitle">
            Create {WORKSPACE_INSTRUCTIONS_FILE} at the workspace root (visible in the workspace
            file editor) to add repo-specific instructions: {workspacePath}/
            {WORKSPACE_INSTRUCTIONS_FILE}
          </p>
        )}
      </div>
    </div>
  )
}
