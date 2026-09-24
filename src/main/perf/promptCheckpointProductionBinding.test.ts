import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const orchestratorSource = readFileSync(
  new URL('../services/EnsembleOrchestrator.ts', import.meta.url),
  'utf8'
)
const persistSource = readFileSync(
  new URL('../host/HostThreadRecordPersistCommand.ts', import.meta.url),
  'utf8'
)

describe('prompt_build and checkpoint_prepare production binding', () => {
  it('binds the process recorder for lazily constructed persist clients', () => {
    expect(indexSource).toContain('bindMainWorkSpanSink(mainWorkSpanRecorder)')
    expect(persistSource).toContain('spans: input.spans ?? mainWorkSpanSink()')
    expect(persistSource).toContain('recordCheckpointPrepareSpan(')
  })

  it('wraps Ensemble participant prompt projection with the admission workSpans sink', () => {
    expect(orchestratorSource).toContain('recordPromptBuildSpan(')
    expect(orchestratorSource).toContain('this.hostAdmission.workSpans')
    const wraps = orchestratorSource.split('recordPromptBuildSpan(').length - 1
    expect(wraps).toBe(3)
  })
})
