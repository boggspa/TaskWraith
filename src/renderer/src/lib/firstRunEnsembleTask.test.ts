import { describe, expect, it } from 'vitest'
import {
  FIRST_RUN_ENSEMBLE_TASK,
  FIRST_RUN_ENSEMBLE_TASK_ID,
  getFirstRunEnsembleTaskPrompt
} from './firstRunEnsembleTask'

describe('first-run Ensemble task', () => {
  it('is a stable, provider-agnostic inspection-only task', () => {
    expect(FIRST_RUN_ENSEMBLE_TASK.id).toBe(FIRST_RUN_ENSEMBLE_TASK_ID)
    expect(FIRST_RUN_ENSEMBLE_TASK.prompt).toBe(getFirstRunEnsembleTaskPrompt())
    expect(FIRST_RUN_ENSEMBLE_TASK.prompt).toContain('[TaskWraith first-run Ensemble sample]')
    expect(FIRST_RUN_ENSEMBLE_TASK.prompt).toMatch(/read-only exercise/i)
    expect(FIRST_RUN_ENSEMBLE_TASK.prompt).toMatch(/do not edit, create, delete, commit/i)
    expect(FIRST_RUN_ENSEMBLE_TASK.recommendedSetup.join('\n')).toMatch(
      /Read-only permission role/i
    )
    expect(FIRST_RUN_ENSEMBLE_TASK.recommendedSetup.join('\n')).toMatch(
      /prompt cannot set permissions/i
    )
    expect(FIRST_RUN_ENSEMBLE_TASK.prompt).toContain('## Ranked verdict')
    expect(FIRST_RUN_ENSEMBLE_TASK.prompt).toContain('## Evidence still missing')
  })

  it('forces visible composition instead of promising decorative parallelism', () => {
    const { prompt, expectedSignals } = FIRST_RUN_ENSEMBLE_TASK

    expect(prompt).toMatch(/distinct lenses/i)
    expect(prompt).toMatch(/hand-offs/i)
    expect(prompt).toMatch(/must cite at least two peer findings/i)
    expect(expectedSignals).toHaveLength(5)
    expect(expectedSignals.join('\n')).toMatch(/reviewer/i)
    expect(expectedSignals.join('\n')).toMatch(/No file.*mutation/i)
  })

  it('does not embed machine-specific or provider-specific setup', () => {
    const text = JSON.stringify(FIRST_RUN_ENSEMBLE_TASK)

    expect(text).not.toMatch(/\/Users\//)
    expect(text).not.toMatch(/\\Users\\/)
    expect(text).not.toMatch(/api[_ -]?key|bearer\s+token|sk-[A-Za-z0-9]/i)
    expect(text).not.toMatch(/Codex|Claude|Kimi|Grok|Ollama|Cursor/i)
  })
})
