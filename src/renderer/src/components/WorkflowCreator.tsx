import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatRecord, WorkflowDefinition, WorkspaceRecord } from '../../../main/store/types'
import { getChatProvider } from '../lib/chatScope'
import { getProviderLabel } from '../lib/providerLabels'

export interface WorkflowCreatorSubmitInput {
  name: string
  prompt: string
  trigger: WorkflowDefinition['trigger']
  enabled: boolean
  maxRunsPerDay: number
}

interface WorkflowCreatorProps {
  open: boolean
  workspace: WorkspaceRecord | null
  targetChat: ChatRecord | null
  initialPrompt: string
  localHistoryEnabled: boolean
  onSubmit: (input: WorkflowCreatorSubmitInput) => Promise<void> | void
  onCancel: () => void
}

function defaultWorkflowName(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New workflow'
}

function workflowTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

export function buildWorkflowCreatorTrigger(
  cadence: 'manual' | 'interval',
  intervalMinutes: number
): WorkflowDefinition['trigger'] {
  if (cadence === 'manual') return { kind: 'manual' }
  const intervalMs = Math.max(60_000, Math.round(intervalMinutes * 60_000))
  return {
    kind: 'interval',
    intervalMs,
    startAt: new Date(Date.now() + intervalMs).toISOString(),
    timezone: workflowTimezone()
  }
}

export function WorkflowCreator({
  open,
  workspace,
  targetChat,
  initialPrompt,
  localHistoryEnabled,
  onSubmit,
  onCancel
}: WorkflowCreatorProps) {
  const [name, setName] = useState(defaultWorkflowName(initialPrompt))
  const [prompt, setPrompt] = useState(initialPrompt)
  const [cadence, setCadence] = useState<'manual' | 'interval'>('interval')
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(24)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!open) return
    setName(defaultWorkflowName(initialPrompt))
    setPrompt(initialPrompt)
    setCadence('interval')
    setIntervalMinutes(60)
    setMaxRunsPerDay(24)
    setSubmitting(false)
    setError(null)
    const focusTimer = window.setTimeout(() => {
      if (initialPrompt.trim()) return
      promptRef.current?.focus()
    }, 50)
    return () => window.clearTimeout(focusTimer)
  }, [initialPrompt, open])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onCancel, open])

  const targetSummary = useMemo(() => {
    if (!workspace) return 'Choose a workspace before creating a workflow.'
    if (!localHistoryEnabled) return 'Enable local chat history before creating workflows.'
    if (!targetChat) return `A new ${workspace.displayName || 'workspace'} chat will be created.`
    return `${workspace.displayName || 'Workspace'} / ${targetChat.title || 'Current chat'}`
  }, [localHistoryEnabled, targetChat, workspace])

  if (!open) return null

  const submit = async (): Promise<void> => {
    const trimmedName = name.trim()
    const trimmedPrompt = prompt.trim()
    if (!workspace) {
      setError('Open a workspace before creating a workflow.')
      return
    }
    if (!localHistoryEnabled) {
      setError('Workflows persist prompts and run templates. Enable local chat history first.')
      return
    }
    if (!trimmedName) {
      setError('Workflow name is required.')
      return
    }
    if (!trimmedPrompt) {
      setError('Workflow prompt is required.')
      return
    }
    if (cadence === 'interval' && (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0)) {
      setError('Cadence must be at least 1 minute.')
      return
    }
    if (!Number.isFinite(maxRunsPerDay) || maxRunsPerDay < 1) {
      setError('Daily run limit must be at least 1.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        name: trimmedName,
        prompt: trimmedPrompt,
        trigger: buildWorkflowCreatorTrigger(cadence, intervalMinutes),
        enabled: true,
        maxRunsPerDay: Math.max(1, Math.floor(maxRunsPerDay))
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="workflow-creator-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
      role="presentation"
    >
      <section
        className="workflow-creator"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-creator-title"
      >
        <header className="workflow-creator-header">
          <div>
            <h2 id="workflow-creator-title">Create workflow</h2>
            <p>Save a repeatable run template for this workspace.</p>
          </div>
          <button
            type="button"
            className="workflow-creator-close"
            onClick={onCancel}
            aria-label="Close workflow creator"
          >
            Close
          </button>
        </header>

        <div className="workflow-creator-body">
          <div
            className={`workflow-creator-target${
              workspace && localHistoryEnabled ? '' : ' is-blocked'
            }`}
          >
            <span>Target</span>
            <strong>{targetSummary}</strong>
            {!localHistoryEnabled ? (
              <small>Workflows need a durable chat/template so scheduled runs can resume.</small>
            ) : targetChat ? (
              <small>{getProviderLabel(getChatProvider(targetChat))} run settings will be captured.</small>
            ) : workspace ? (
              <small>The workflow will still run through the normal scheduled-task queue.</small>
            ) : null}
          </div>

          <label className="workflow-creator-field">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Audit loop"
            />
          </label>

          <label className="workflow-creator-field">
            <span>Prompt</span>
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={6}
              placeholder="Describe the recurring task the agent should run."
            />
          </label>

          <div className="workflow-creator-field">
            <span>Cadence</span>
            <div className="workflow-creator-segmented" role="group" aria-label="Workflow cadence">
              <button
                type="button"
                className={cadence === 'manual' ? 'is-active' : ''}
                onClick={() => setCadence('manual')}
              >
                Manual
              </button>
              <button
                type="button"
                className={cadence === 'interval' ? 'is-active' : ''}
                onClick={() => setCadence('interval')}
              >
                Every
              </button>
            </div>
          </div>

          {cadence === 'interval' && (
            <label className="workflow-creator-field workflow-creator-inline-field">
              <span>Minutes</span>
              <input
                type="number"
                min={1}
                step={1}
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
              />
            </label>
          )}

          <label className="workflow-creator-field workflow-creator-inline-field">
            <span>Max runs per day</span>
            <input
              type="number"
              min={1}
              step={1}
              value={maxRunsPerDay}
              onChange={(event) => setMaxRunsPerDay(Number(event.target.value))}
            />
          </label>

          {error && <div className="workflow-creator-error">{error}</div>}
        </div>

        <footer className="workflow-creator-footer">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={submitting || !workspace || !localHistoryEnabled}
          >
            {submitting ? 'Creating...' : 'Create workflow'}
          </button>
        </footer>
      </section>
    </div>
  )
}
