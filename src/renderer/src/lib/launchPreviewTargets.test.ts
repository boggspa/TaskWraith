import { describe, expect, it } from 'vitest'
import type { LaunchAttempt } from '../../../main/launch/types'
import type { LaunchTarget } from '../../../main/launchTargets/types'
import { buildLaunchPreviewTargets, launchPreviewActionTitle } from './launchPreviewTargets'

function target(overrides: Partial<LaunchTarget>): LaunchTarget {
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

describe('buildLaunchPreviewTargets', () => {
  it('opens running local-server targets before startable commands', () => {
    const rows = buildLaunchPreviewTargets(
      [
        target({
          id: 'dev',
          label: 'npm run dev',
          git: {
            isRepo: true,
            repoRoot: '/repo/app',
            branch: 'feature/run-button'
          }
        }),
        target({
          id: 'server',
          label: 'vite :5173',
          source: 'local-server',
          kind: 'preview',
          url: 'http://localhost:5173',
          primaryPort: 5173,
          command: undefined
        })
      ],
      [],
      '/repo/app'
    )

    expect(rows.map((row) => [row.action, row.state, row.label])).toEqual([
      ['open', 'open', 'vite :5173'],
      ['start', 'startable', 'npm run dev']
    ])
    expect(rows.find((row) => row.label === 'npm run dev')?.subtitle).toContain(
      'feature/run-button'
    )
  })

  it('turns active attempts into stop rows', () => {
    const rows = buildLaunchPreviewTargets(
      [target({ id: 'dev' })],
      [attempt({ id: 'attempt-active', targetId: 'dev', status: 'running' })],
      '/repo/app'
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'attempt:attempt-active',
      action: 'stop',
      state: 'running',
      label: 'npm run dev'
    })
  })

  it('keeps stale active attempts stop-able when the target disappears', () => {
    const rows = buildLaunchPreviewTargets(
      [target({ id: 'other', label: 'npm run preview' })],
      [attempt({ id: 'attempt-stale', targetId: 'missing', targetLabel: 'npm run dev' })],
      '/repo/app'
    )

    expect(rows.map((row) => [row.id, row.action, row.state, row.label])).toContainEqual([
      'attempt:attempt-stale',
      'stop',
      'running',
      'npm run dev'
    ])
  })

  it('marks blocked and shell-backed targets disabled', () => {
    const rows = buildLaunchPreviewTargets(
      [
        target({ id: 'blocked', blockers: ['Pick a device first.'] }),
        target({
          id: 'shell',
          command: {
            raw: 'npm run dev && echo done',
            cwd: '/repo/app',
            longRunning: true,
            shell: true
          }
        })
      ],
      [],
      '/repo/app'
    )

    expect(rows.find((row) => row.target?.id === 'blocked')).toMatchObject({
      action: 'disabled',
      state: 'blocked',
      reason: 'Pick a device first.'
    })
    expect(rows.find((row) => row.target?.id === 'shell')).toMatchObject({
      action: 'disabled',
      state: 'blocked'
    })
  })

  it('filters targets and attempts by workspace', () => {
    const rows = buildLaunchPreviewTargets(
      [target({ id: 'inside' }), target({ id: 'outside', workspacePath: '/repo/other' })],
      [attempt({ id: 'outside-attempt', workspacePath: '/repo/other' })],
      '/repo/app/'
    )

    expect(rows.map((row) => row.target?.id || row.attempt?.id)).toEqual(['inside'])
  })
})

describe('launchPreviewActionTitle', () => {
  it('describes single open, start, and stop rows', () => {
    expect(
      launchPreviewActionTitle(
        buildLaunchPreviewTargets(
          [
            target({
              id: 'server',
              source: 'local-server',
              kind: 'preview',
              url: 'http://localhost:5173',
              command: undefined
            })
          ],
          [],
          '/repo/app'
        ),
        true
      )
    ).toBe('Open preview at http://localhost:5173')
    expect(launchPreviewActionTitle(buildLaunchPreviewTargets([target({})], [], '/repo/app'), true)).toBe(
      'Start npm run dev'
    )
    expect(
      launchPreviewActionTitle(
        buildLaunchPreviewTargets([target({})], [attempt({ status: 'running' })], '/repo/app'),
        true
      )
    ).toBe('Stop npm run dev')
    expect(
      launchPreviewActionTitle(
        buildLaunchPreviewTargets([target({ blockers: ['Pick a device first.'] })], [], '/repo/app'),
        true
      )
    ).toBe('Pick a device first.')
  })
})
