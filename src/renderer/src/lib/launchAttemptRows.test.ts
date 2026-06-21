import { describe, expect, it } from 'vitest'
import type { LaunchAttempt } from '../../../main/launch/types'
import type { LaunchTarget } from '../../../main/launchTargets/types'
import { buildLaunchAttemptRows, isLaunchAttemptActive } from './launchAttemptRows'

function target(overrides: Partial<LaunchTarget> = {}): LaunchTarget {
  return {
    id: overrides.id || 'target-dev',
    label: overrides.label || 'npm run dev',
    workspacePath: overrides.workspacePath || '/repo/app',
    source: overrides.source || 'package-script',
    kind: overrides.kind || 'dev-server',
    platform: overrides.platform || 'web',
    confidence: overrides.confidence ?? 0.9,
    command: overrides.command ?? {
      raw: 'npm run dev',
      argv: ['npm', 'run', 'dev'],
      cwd: overrides.workspacePath || '/repo/app',
      longRunning: true
    },
    evidence: overrides.evidence || [{ path: '/repo/app/package.json' }],
    blockers: overrides.blockers || [],
    ...overrides
  }
}

function attempt(overrides: Partial<LaunchAttempt>): LaunchAttempt {
  return {
    schemaVersion: 1,
    id: overrides.id || 'attempt-1',
    targetId: overrides.targetId || 'target-dev',
    targetLabel: overrides.targetLabel || 'npm run dev',
    targetSource: overrides.targetSource || 'package-script',
    targetKind: overrides.targetKind || 'dev-server',
    targetSnapshot: overrides.targetSnapshot || target({ id: overrides.targetId || 'target-dev' }),
    targetSnapshotHash: overrides.targetSnapshotHash || 'hash',
    provider: overrides.provider || 'codex',
    workspacePath: overrides.workspacePath || '/repo/app',
    cwd: overrides.cwd || '/repo/app',
    commandRaw: overrides.commandRaw || 'npm run dev',
    argv: overrides.argv || ['npm', 'run', 'dev'],
    status: overrides.status || 'running',
    startedAt: overrides.startedAt || '2026-06-21T12:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-06-21T12:00:01.000Z',
    outputTail: overrides.outputTail || '',
    outputTailBytes: overrides.outputTailBytes || 0,
    outputTruncated: overrides.outputTruncated || false,
    ...overrides
  }
}

describe('isLaunchAttemptActive', () => {
  it('treats owned process states as active', () => {
    expect(isLaunchAttemptActive('starting')).toBe(true)
    expect(isLaunchAttemptActive('running')).toBe(true)
    expect(isLaunchAttemptActive('stopping')).toBe(true)
    expect(isLaunchAttemptActive('stopped')).toBe(false)
    expect(isLaunchAttemptActive('failed')).toBe(false)
  })
})

describe('buildLaunchAttemptRows', () => {
  it('orders active attempts before recent terminal attempts', () => {
    const rows = buildLaunchAttemptRows(
      [
        attempt({
          id: 'stopped-newer',
          status: 'stopped',
          updatedAt: '2026-06-21T12:05:00.000Z'
        }),
        attempt({
          id: 'running-older',
          status: 'running',
          updatedAt: '2026-06-21T12:01:00.000Z'
        }),
        attempt({
          id: 'failed',
          status: 'failed',
          updatedAt: '2026-06-21T12:04:00.000Z'
        })
      ],
      new Date('2026-06-21T12:06:00.000Z')
    )

    expect(rows.map((row) => [row.id, row.statusLabel, row.tone])).toEqual([
      ['running-older', 'Running', 'active'],
      ['failed', 'Failed', 'bad'],
      ['stopped-newer', 'Stopped', 'done']
    ])
  })

  it('formats metadata and keeps only the final output lines', () => {
    const rows = buildLaunchAttemptRows(
      [
        attempt({
          status: 'running',
          pid: 12345,
          workspacePath: '/repo/app',
          git: {
            isRepo: true,
            repoRoot: '/repo/app',
            branch: 'feature/run-button'
          },
          cwd: '/repo/app/packages/web',
          detectedUrls: ['http://localhost:5173/'],
          outputTail: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n'),
          outputTruncated: true
        })
      ],
      new Date('2026-06-21T12:01:05.000Z')
    )

    expect(rows[0]).toMatchObject({
      workspaceName: 'app',
      command: 'npm run dev',
      cwd: '/repo/app/packages/web',
      pid: 12345,
      branchLabel: 'feature/run-button',
      previewUrl: 'http://localhost:5173/',
      executionLabel: 'long-running',
      duration: '1m 5s',
      canStop: true,
      outputTruncated: true
    })
    expect(rows[0].outputPreview).toBe(
      ['line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10'].join('\n')
    )
  })

  it('falls back to target snapshot git context for older attempts', () => {
    const rows = buildLaunchAttemptRows([
      attempt({
        targetSnapshot: target({
          git: {
            isRepo: true,
            repoRoot: '/repo/app',
            detached: true,
            head: '1234567890abcdef'
          }
        })
      })
    ])

    expect(rows[0].branchLabel).toBe('detached 1234567')
  })

  it('labels completed finite commands as succeeded', () => {
    const rows = buildLaunchAttemptRows(
      [
        attempt({
          status: 'stopped',
          targetLabel: 'npm run build',
          commandRaw: 'npm run build',
          targetSnapshot: target({
            label: 'npm run build',
            kind: 'build',
            command: {
              raw: 'npm run build',
              argv: ['npm', 'run', 'build'],
              cwd: '/repo/app',
              longRunning: false
            }
          }),
          startedAt: '2026-06-21T12:00:00.000Z',
          endedAt: '2026-06-21T12:00:17.000Z',
          updatedAt: '2026-06-21T12:00:17.000Z'
        })
      ],
      new Date('2026-06-21T12:02:00.000Z')
    )

    expect(rows[0]).toMatchObject({
      status: 'stopped',
      statusLabel: 'Succeeded',
      executionLabel: 'finite',
      duration: '17s'
    })
  })

  it('allows recovered interrupted attempts with a pid to be stopped', () => {
    const rows = buildLaunchAttemptRows([
      attempt({
        id: 'recovered',
        status: 'interrupted',
        pid: 9876,
        pgid: 9876,
        lastError: 'TaskWraith restarted before this launch finished.'
      }),
      attempt({
        id: 'missing-pid',
        status: 'interrupted'
      })
    ])

    expect(rows.find((row) => row.id === 'recovered')).toMatchObject({
      statusLabel: 'Interrupted',
      canStop: true
    })
    expect(rows.find((row) => row.id === 'missing-pid')).toMatchObject({
      statusLabel: 'Interrupted',
      canStop: false
    })
  })
})
