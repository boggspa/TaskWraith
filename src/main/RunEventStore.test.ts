import { describe, expect, it } from 'vitest'
import {
  createRunEventRecord,
  createRunEventReplay,
  filterRunEvents,
  nextRunEventSequence,
  parseRunEventLine,
  prepareRunEventPayload,
  safeRunEventFileName,
  serializeRunEventRecord,
  verifyRunEventHashChain
} from './RunEventStore'
import type { RunEventRecord } from './store/types'

describe('RunEventStore', () => {
  it('creates durable schema-versioned events with stable sequence numbers', () => {
    const record = createRunEventRecord(
      {
        runId: 'run-1',
        chatId: 'chat-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        provider: 'gemini',
        kind: 'lifecycle',
        phase: 'control',
        source: 'renderer',
        summary: 'Run requested',
        payload: { requestedModel: 'flash' }
      },
      7,
      { now: '2026-05-07T00:00:00.000Z' }
    )

    expect(record.schemaVersion).toBe(1)
    expect(record.sequence).toBe(7)
    expect(record.previousHash).toMatch(/^0{64}$/)
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(record.spanId).toBe('run-1:7')
    expect(record.runId).toBe('run-1')
    expect(record.timestamp).toBe('2026-05-07T00:00:00.000Z')
    expect(record.payload).toEqual({ requestedModel: 'flash' })
  })

  it('hash chains immutable JSONL events', () => {
    const first = createRunEventRecord(
      { runId: 'run-1', kind: 'lifecycle', phase: 'control', source: 'main' },
      1,
      { now: '2026-05-07T00:00:00.000Z' }
    )
    const second = createRunEventRecord(
      {
        runId: 'run-1',
        kind: 'provider_raw',
        phase: 'raw',
        source: 'provider',
        payload: { data: 'hello' }
      },
      2,
      { now: '2026-05-07T00:00:01.000Z', previousHash: first.hash }
    )

    expect(second.previousHash).toBe(first.hash)
    expect(verifyRunEventHashChain([first, second])).toBe(true)
    expect(verifyRunEventHashChain([{ ...second, summary: 'tampered' }, first])).toBe(false)
  })

  it('sanitizes run ids for per-run JSONL filenames', () => {
    expect(safeRunEventFileName('codex/run:1')).toBe('codex_run_1.jsonl')
    expect(safeRunEventFileName('')).toBe('unknown-run.jsonl')
  })

  it('round-trips JSONL records and ignores malformed lines', () => {
    const record = createRunEventRecord(
      {
        runId: 'run-1',
        kind: 'provider_exit',
        phase: 'raw',
        source: 'provider',
        summary: 'Exit',
        payload: { code: 0 }
      },
      1,
      { now: '2026-05-07T00:00:00.000Z' }
    )

    expect(parseRunEventLine(serializeRunEventRecord(record))).toEqual(record)
    expect(parseRunEventLine('{bad json')).toBeNull()
    expect(parseRunEventLine(JSON.stringify({ runId: 'run-1' }))).toBeNull()
  })

  it('always redacts raw provider payloads before durable persistence', () => {
    const payload = prepareRunEventPayload(
      { data: 'secret-ish provider stream token=abc1234567890' },
      { rawProviderPayload: true, storeRawPayload: true }
    ) as { redacted: boolean; preview: string; byteLength: number; rawStored: boolean }

    expect(payload.redacted).toBe(true)
    expect(payload.rawStored).toBe(false)
    expect(payload.preview).toContain('secret-ish provider stream')
    expect(payload.preview).toContain('token=[redacted]')
    expect(payload.preview).not.toContain('abc1234567890')
    expect(payload.byteLength).toBeGreaterThan(0)
  })

  it('filters events by run, provider, kind, and sequence', () => {
    const events: RunEventRecord[] = [
      createRunEventRecord(
        { runId: 'run-1', provider: 'gemini', kind: 'lifecycle', phase: 'control', source: 'main' },
        1
      ),
      createRunEventRecord(
        {
          runId: 'run-1',
          provider: 'gemini',
          kind: 'tool',
          phase: 'normalized',
          source: 'renderer',
          payload: { tool_id: 'tool-1' }
        },
        2
      ),
      createRunEventRecord(
        {
          runId: 'run-2',
          provider: 'codex',
          kind: 'tool',
          phase: 'normalized',
          source: 'renderer'
        },
        1
      )
    ]

    expect(filterRunEvents(events, { runId: 'run-1', kinds: ['tool'] })).toHaveLength(1)
    expect(filterRunEvents(events, { provider: 'gemini', fromSequence: 2 })).toHaveLength(1)
    expect(filterRunEvents(events, { limit: 2 }).map((event) => event.runId)).toEqual([
      'run-1',
      'run-2'
    ])
    expect(nextRunEventSequence(events.filter((event) => event.runId === 'run-1'))).toBe(3)
  })

  it('projects approval ids into records, filters, and replay timelines', () => {
    const request = createRunEventRecord(
      {
        runId: 'run-approval',
        kind: 'approval_request',
        phase: 'control',
        source: 'main',
        payload: { id: 'approval-1', title: 'Approve command' }
      },
      1
    )
    const response = {
      ...createRunEventRecord(
        {
          runId: 'run-approval',
          kind: 'approval_response',
          phase: 'control',
          source: 'main',
          payload: { requestId: 'approval-1', action: 'accept' }
        },
        2,
        { previousHash: request.hash }
      ),
      // Simulate an older parsed event whose durable hash predated the top-level
      // approvalId field. Replay should infer the join key without mutating it.
      approvalId: undefined
    }

    expect(request.approvalId).toBe('approval-1')
    expect(filterRunEvents([request, response], { approvalId: 'approval-1' })).toHaveLength(2)

    const replay = createRunEventReplay('run-approval', [request, response])
    expect(replay.approvalIds).toEqual(['approval-1'])
    expect(replay.timeline.map((event) => event.approvalId)).toEqual([
      'approval-1',
      'approval-1'
    ])
    expect(response.approvalId).toBeUndefined()
  })

  it('hash-binds reference-context approval links and immutable artifact refs', () => {
    const event = createRunEventRecord(
      {
        runId: 'run-context',
        chatId: 'chat-context',
        approvalId: 'approval-context',
        kind: 'reference_context',
        phase: 'artifact',
        source: 'main',
        payload: { schemaVersion: 1, purpose: 'approval-context', action: 'linked' },
        artifacts: [
          {
            id: 'project-reference:abc',
            kind: 'snapshot',
            path: '/private/reference-context/abc.snapshot',
            sha256: 'abc',
            sizeBytes: 3
          }
        ]
      },
      1
    )

    expect(parseRunEventLine(serializeRunEventRecord(event))).toMatchObject({
      approvalId: 'approval-context',
      artifacts: [{ sha256: 'abc', sizeBytes: 3 }]
    })
    expect(verifyRunEventHashChain([event])).toBe(true)
    expect(
      verifyRunEventHashChain([{ ...event, approvalId: 'approval-tampered' }])
    ).toBe(false)
    expect(
      verifyRunEventHashChain([
        { ...event, artifacts: [{ ...event.artifacts![0], sha256: 'def' }] }
      ])
    ).toBe(false)
  })

  it('infers external urls from tool payload url fields', () => {
    const event = createRunEventRecord(
      {
        runId: 'run-pr',
        kind: 'tool',
        phase: 'control',
        source: 'provider',
        payload: { toolName: 'git_create_pr', result: { url: 'https://example.test/pr/2' } }
      },
      1
    )

    expect(event.externalUrl).toBe('https://example.test/pr/2')
    expect(createRunEventReplay('run-pr', [event]).timeline[0].externalUrl).toBe(
      'https://example.test/pr/2'
    )
  })

  it('builds replay metadata for a run journal', () => {
    const first = createRunEventRecord(
      {
        runId: 'run-1',
        kind: 'lifecycle',
        phase: 'control',
        source: 'renderer',
        payload: { status: 'starting' }
      },
      1,
      { now: '2026-05-07T00:00:00.000Z' }
    )
    const second = createRunEventRecord(
      {
        runId: 'run-1',
        kind: 'final_message',
        phase: 'normalized',
        source: 'renderer',
        approvalId: 'approval-final',
        commitSha: 'abc123',
        externalUrl: 'https://example.test/pr/1',
        payload: { content: 'Done' }
      },
      2,
      { now: '2026-05-07T00:00:01.000Z', previousHash: first.hash }
    )
    const third = createRunEventRecord(
      {
        runId: 'run-1',
        kind: 'lifecycle',
        phase: 'control',
        source: 'main',
        payload: { status: 'completed' }
      },
      3,
      { now: '2026-05-07T00:00:02.000Z', previousHash: second.hash }
    )
    const events: RunEventRecord[] = [first, second, third]

    const replay = createRunEventReplay('run-1', events)
    expect(replay.count).toBe(3)
    expect(replay.lastSequence).toBe(3)
    expect(replay.countsByKind.lifecycle).toBe(2)
    expect(replay.countsByKind.final_message).toBe(1)
    expect(replay.hashChainValid).toBe(true)
    expect(replay.timeline).toHaveLength(3)
    expect(replay.approvalIds).toEqual(['approval-final'])
    expect(replay.timeline[1].approvalId).toBe('approval-final')
    expect(replay.timeline[1].commitSha).toBe('abc123')
    expect(replay.timeline[1].externalUrl).toBe('https://example.test/pr/1')
    expect(replay.hashHead).toBe(events[2].hash)
    expect(replay.startedAt).toBe('2026-05-07T00:00:00.000Z')
    expect(replay.endedAt).toBe('2026-05-07T00:00:02.000Z')
  })
})
