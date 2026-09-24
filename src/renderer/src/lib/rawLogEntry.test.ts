import { describe, expect, it } from 'vitest'
import type { RunEventRecord } from '../../../main/store/types'
import { formatProviderDiagnosticNotice } from '../../../shared/providerDiagnosticNotice'
import { rawLogFromRunEvent } from './rawLogEntry'

function runEvent(overrides: Partial<RunEventRecord>): RunEventRecord {
  return {
    schemaVersion: 1,
    id: 'evt-1',
    sequence: 1,
    previousHash: '',
    hash: 'h',
    runId: 'run-1',
    provider: 'kimi',
    kind: 'provider_raw',
    phase: 'raw',
    source: 'provider',
    timestamp: '2026-08-25T00:00:00.000Z',
    ...overrides
  } as RunEventRecord
}

const NOTICE = formatProviderDiagnosticNotice({
  provider: 'kimi',
  source: 'kimi-runtime-admission',
  message: 'Kimi is running under the explicit unattested-development bypass.'
})

describe('rawLogFromRunEvent', () => {
  it('buckets a rehydrated provider diagnostic as info, not provider stdout', () => {
    // The payload is dropped unless storeRawEvents is on, so the summary is all
    // that survives — and for a diagnostic the summary IS the notice.
    const entry = rawLogFromRunEvent(runEvent({ summary: NOTICE }))
    expect(entry?.type).toBe('info')
    expect(entry?.content).toContain('unattested-development bypass')
  })

  it('leaves ordinary provider_raw output on stdout', () => {
    const entry = rawLogFromRunEvent(runEvent({ summary: 'Provider output: content' }))
    expect(entry?.type).toBe('stdout')
  })

  it('still prefers a retained raw payload over the summary', () => {
    const entry = rawLogFromRunEvent(
      runEvent({ summary: NOTICE, payload: { data: 'literal stdout bytes' } })
    )
    expect(entry?.type).toBe('stdout')
    expect(entry?.content).toBe('literal stdout bytes')
  })

  it('drops an event with neither payload text nor summary', () => {
    expect(rawLogFromRunEvent(runEvent({ summary: '' }))).toBeNull()
  })
})
