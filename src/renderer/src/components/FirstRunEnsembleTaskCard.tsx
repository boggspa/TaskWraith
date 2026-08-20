import { useState } from 'react'
import { FIRST_RUN_ENSEMBLE_TASK } from '../lib/firstRunEnsembleTask'

export type FirstRunEnsembleTaskCopy = (text: string) => Promise<void>

async function copyWithBrowserClipboard(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable.')
  }
  await navigator.clipboard.writeText(text)
}

export interface FirstRunEnsembleTaskCardProps {
  /** Injectable for tests and for a host that supplies a native clipboard. */
  copyText?: FirstRunEnsembleTaskCopy
}

/**
 * A first-run answer to “what should I do to test Ensemble?”. The card only
 * prepares a user-authored prompt: creating the chat, choosing seats, and
 * pressing Send remain explicit user actions.
 */
export function FirstRunEnsembleTaskCard({
  copyText = copyWithBrowserClipboard
}: FirstRunEnsembleTaskCardProps): React.JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')

  const handleCopy = (): void => {
    setCopyState('copying')
    void copyText(FIRST_RUN_ENSEMBLE_TASK.prompt)
      .then(() => setCopyState('copied'))
      .catch(() => setCopyState('failed'))
  }

  const buttonLabel =
    copyState === 'copying'
      ? 'Copying…'
      : copyState === 'copied'
        ? 'Copied'
        : copyState === 'failed'
          ? 'Try copy again'
          : 'Copy task'

  return (
    <section
      className="first-run-ensemble-task"
      aria-labelledby="first-run-ensemble-task-title"
      data-first-run-ensemble-task={FIRST_RUN_ENSEMBLE_TASK.id}
    >
      <div className="first-run-ensemble-task-heading">
        <div>
          <h4 id="first-run-ensemble-task-title">Try this first: a governed workspace review</h4>
          <p>{FIRST_RUN_ENSEMBLE_TASK.summary}</p>
        </div>
        <span className="first-run-ensemble-task-badge">Suggested safe setup</span>
      </div>

      <ol className="first-run-ensemble-task-setup">
        {FIRST_RUN_ENSEMBLE_TASK.recommendedSetup.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <details className="first-run-ensemble-task-details">
        <summary>Show the sample task</summary>
        <pre className="first-run-ensemble-task-prompt">
          <code>{FIRST_RUN_ENSEMBLE_TASK.prompt}</code>
        </pre>
      </details>

      <div className="first-run-ensemble-task-actions">
        <button
          type="button"
          className="first-run-ensemble-task-copy"
          onClick={handleCopy}
          disabled={copyState === 'copying'}
        >
          {buttonLabel}
        </button>
        <span className="first-run-ensemble-task-hint" role="status" aria-live="polite">
          {copyState === 'copied'
            ? 'Create an Ensemble chat, paste the task, and send it when you are ready.'
            : copyState === 'failed'
              ? 'Clipboard access failed; open the sample above and copy it manually.'
              : 'Nothing runs or changes until you paste and send it yourself.'}
        </span>
      </div>
    </section>
  )
}
