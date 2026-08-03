import { describe, expect, it } from 'vitest'

import type { RunEventRecord } from '../store/types'
import {
  filterProjectReferenceLegacyArtifactRefsForPendingDeletion,
  projectReferenceOwnedArtifactRefsFromRunEvent,
  projectReferenceOwnedArtifactRefsFromRunEvents
} from './ProjectReferenceLegacyOwnership'

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

describe('ProjectReferenceLegacyOwnership', () => {
  it('projects only canonical main-owned reference artifacts', () => {
    expect(projectReferenceOwnedArtifactRefsFromRunEvent(event())).toEqual([
      {
        sha256: 'a'.repeat(64),
        path: '/private/snapshots/' + 'a'.repeat(64) + '.snapshot',
        sizeBytes: 12,
        appChatId: 'chat-a',
        runId: 'run-a'
      }
    ])
    expect(projectReferenceOwnedArtifactRefsFromRunEvent(event({ source: 'provider' }))).toEqual([])
    expect(projectReferenceOwnedArtifactRefsFromRunEvent(event({ phase: 'control' }))).toEqual([])
    expect(
      projectReferenceOwnedArtifactRefsFromRunEvent(
        event({ artifacts: [{ ...event().artifacts![0], kind: 'file' }] })
      )
    ).toEqual([])
  })

  it('applies a frozen pending-deletion scope after projection', () => {
    const references = projectReferenceOwnedArtifactRefsFromRunEvents([
      event(),
      event({ id: 'event-b', runId: 'run-b', chatId: 'chat-b' })
    ])

    expect(
      filterProjectReferenceLegacyArtifactRefsForPendingDeletion(references, {
        kind: 'chat',
        chatIds: ['chat-a'],
        runIds: ['run-a']
      })
    ).toEqual([expect.objectContaining({ appChatId: 'chat-b', runId: 'run-b' })])
    expect(
      filterProjectReferenceLegacyArtifactRefsForPendingDeletion(references, {
        kind: 'global',
        chatIds: ['chat-a', 'chat-b'],
        runIds: ['run-a', 'run-b']
      })
    ).toEqual([])
  })
})
