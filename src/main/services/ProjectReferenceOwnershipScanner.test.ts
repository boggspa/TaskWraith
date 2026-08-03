import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { serializeRunEventRecord } from '../RunEventStore'
import type { RunEventRecord } from '../store/types'
import {
  PROJECT_REFERENCE_OWNERSHIP_SCAN_MAX_LINE_BYTES,
  scanProjectReferenceOwnership
} from './ProjectReferenceOwnershipScanner'

const roots: string[] = []

function makeRunEventsDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-reference-scan-'))
  roots.push(root)
  const directory = path.join(root, 'run-events')
  fs.mkdirSync(directory, { mode: 0o700 })
  return directory
}

function event(overrides: Partial<RunEventRecord> = {}): RunEventRecord {
  return {
    schemaVersion: 1,
    id: 'event-a',
    sequence: 1,
    runId: 'run-a',
    chatId: 'chat-a',
    kind: 'reference_context',
    phase: 'artifact',
    source: 'main',
    timestamp: '2026-08-03T00:00:00.000Z',
    artifacts: [
      {
        id: 'artifact-a',
        kind: 'snapshot',
        path: '/private/snapshots/' + 'a'.repeat(64) + '.snapshot',
        sha256: 'a'.repeat(64),
        sizeBytes: 12,
        metadata: {
          source: 'project_reference_context',
          storage: 'main_owned_snapshot'
        }
      }
    ],
    ...overrides
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('scanProjectReferenceOwnership', () => {
  it('streams only canonical reference records and deduplicates approval links', async () => {
    const directory = makeRunEventsDirectory()
    const canonical = event()
    fs.writeFileSync(
      path.join(directory, 'run-a.jsonl'),
      [
        serializeRunEventRecord(canonical),
        serializeRunEventRecord({ ...canonical, id: 'approval-link', sequence: 2 }),
        serializeRunEventRecord(
          event({
            id: 'provider-copy',
            runId: 'run-provider',
            source: 'provider'
          })
        ),
        JSON.stringify({
          schemaVersion: 1,
          runId: 'false-positive',
          kind: 'provider_raw',
          payload: { kind: 'reference_context' }
        }) + '\n',
        '{malformed json\n'
      ].join('')
    )

    await expect(scanProjectReferenceOwnership({ runEventsDirectory: directory })).resolves.toEqual(
      [
        {
          sha256: 'a'.repeat(64),
          path: '/private/snapshots/' + 'a'.repeat(64) + '.snapshot',
          sizeBytes: 12,
          appChatId: 'chat-a',
          runId: 'run-a'
        }
      ]
    )
  })

  it('fails closed when the archive needed for reconciliation is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-reference-missing-'))
    roots.push(root)

    await expect(
      scanProjectReferenceOwnership({ runEventsDirectory: path.join(root, 'run-events') })
    ).rejects.toThrow('directory is missing')
  })

  it('fails closed on symlinked ledger entries', async () => {
    const directory = makeRunEventsDirectory()
    const outside = path.join(path.dirname(directory), 'outside.jsonl')
    fs.writeFileSync(outside, serializeRunEventRecord(event()))
    fs.symlinkSync(outside, path.join(directory, 'linked.jsonl'))

    await expect(scanProjectReferenceOwnership({ runEventsDirectory: directory })).rejects.toThrow(
      'entry is unsafe'
    )
  })

  it('fails closed instead of materializing an unbounded event line', async () => {
    const directory = makeRunEventsDirectory()
    fs.writeFileSync(
      path.join(directory, 'oversized.jsonl'),
      `${'x'.repeat(PROJECT_REFERENCE_OWNERSHIP_SCAN_MAX_LINE_BYTES + 1)}\n`
    )

    await expect(scanProjectReferenceOwnership({ runEventsDirectory: directory })).rejects.toThrow(
      'line exceeds the bounded scan limit'
    )
  })

  it('fails closed on a malformed candidate or conflicting owner projection', async () => {
    const malformedDirectory = makeRunEventsDirectory()
    fs.writeFileSync(
      path.join(malformedDirectory, 'malformed.jsonl'),
      '{"kind":"reference_context","schemaVersion":1\n'
    )
    await expect(
      scanProjectReferenceOwnership({ runEventsDirectory: malformedDirectory })
    ).rejects.toThrow('candidate event is malformed')

    const conflictingDirectory = makeRunEventsDirectory()
    const canonical = event()
    const conflict = event({
      id: 'event-conflict',
      sequence: 2,
      artifacts: [
        {
          ...canonical.artifacts![0],
          path: '/private/snapshots/conflicting.snapshot'
        }
      ]
    })
    fs.writeFileSync(
      path.join(conflictingDirectory, 'conflict.jsonl'),
      serializeRunEventRecord(canonical) + serializeRunEventRecord(conflict)
    )
    await expect(
      scanProjectReferenceOwnership({ runEventsDirectory: conflictingDirectory })
    ).rejects.toThrow('conflicts for the same artifact and owner')
  })
})
