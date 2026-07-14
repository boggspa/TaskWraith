import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function sourceBetween(start: string, end: string): string {
  const startIndex = appSource.indexOf(start)
  const endIndex = appSource.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return appSource.slice(startIndex, endIndex)
}

describe('durable queued-run directed scope', () => {
  it('persists and rehydrates the directed Ensemble participant id', () => {
    const snapshotBuilder = sourceBetween(
      'const createRunQueueRequestSnapshot =',
      'const persistRunQueueJobForRequest ='
    )
    const rehydrator = sourceBetween(
      'const queuedRunRequestFromJob =',
      'const discordContextSelectionQueueKey ='
    )
    const steerBuilder = sourceBetween(
      'const buildSteerQueuedRunRequest =',
      'const attachSteerMetadataToRequest ='
    )

    expect(snapshotBuilder).toContain(
      '{ dmTargetParticipantId: request.dmTargetParticipantId }'
    )
    expect(rehydrator).toContain('dmTargetParticipantId: request.dmTargetParticipantId')
    expect(steerBuilder).toContain('dmTargetParticipantId: snapshot.dmTargetParticipantId')
  })

  it('persists and rehydrates the immutable linked-worktree target', () => {
    const snapshotBuilder = sourceBetween(
      'const createRunQueueRequestSnapshot =',
      'const persistRunQueueJobForRequest ='
    )
    const rehydrator = sourceBetween(
      'const queuedRunRequestFromJob =',
      'const discordContextSelectionQueueKey ='
    )
    const steerBuilder = sourceBetween(
      'const buildSteerQueuedRunRequest =',
      'const attachSteerMetadataToRequest ='
    )

    expect(snapshotBuilder).toContain(
      'snapshotQueuedRunWorktreeTarget(request.effectiveWorkspacePath)'
    )
    expect(rehydrator).toContain('effectiveWorkspacePath: restoreQueuedRunWorktreeTarget(request)')
    expect(steerBuilder).toContain(
      'effectiveWorkspacePath: restoreQueuedRunWorktreeTarget(snapshot)'
    )
  })

  it('treats identical prompts directed at different participants as distinct jobs', () => {
    const queueRequest = sourceBetween('const queueRunRequest =', 'const queueRunRequestRef =')

    expect(
      queueRequest.match(
        /dmTargetParticipantId === queuedRequest\.dmTargetParticipantId/g
      )
    ).toHaveLength(2)
  })

  it('treats identical prompts targeting different linked worktrees as distinct jobs', () => {
    const queueRequest = sourceBetween('const queueRunRequest =', 'const queueRunRequestRef =')

    expect(
      queueRequest.match(
        /effectiveWorkspacePath === queuedRequest\.effectiveWorkspacePath/g
      )
    ).toHaveLength(2)
  })
})
