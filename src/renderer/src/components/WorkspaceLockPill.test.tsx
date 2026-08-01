import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  createWorkLockProjectionSnapshot,
  type WorkLockProjectionSource
} from '../../../shared/workLockProjection'
import { WorkspaceLockPillView } from './WorkspaceLockPill'

function lock(overrides: Partial<WorkLockProjectionSource> = {}): WorkLockProjectionSource {
  return {
    lockId: 'lock-1',
    status: 'held',
    owner: {
      displayName: 'Builder',
      provider: 'codex',
      chatId: 'chat-1',
      chatTitle: 'Ship 1.9.2',
      laneId: 'lane-1',
      ownerPid: 8821,
      processBirthIdentity: 'private-birth'
    },
    workspace: {
      basePath: '/repo',
      effectivePath: '/worktrees/builder',
      isWorktree: true,
      worktreeName: 'builder',
      branch: 'codex/lock-ui'
    },
    target: {
      kind: 'hunk',
      path: 'src/app.ts',
      startLine: 17,
      endLine: 29
    },
    acquiredAt: '2026-07-29T15:00:00.000Z',
    statusChangedAt: '2026-07-29T15:00:00.000Z',
    ownerPid: 8821,
    processBirthIdentity: 'private-birth',
    ...overrides
  }
}

describe('WorkspaceLockPillView', () => {
  it('renders compact active count and complete human-readable lock details', () => {
    const snapshot = createWorkLockProjectionSnapshot({
      generation: 2,
      sampledAt: '2026-07-29T15:10:00.000Z',
      locks: [lock()]
    })
    const html = renderToStaticMarkup(
      <WorkspaceLockPillView
        snapshot={snapshot}
        effectiveWorkspacePath="/worktrees/builder"
        nowMs={Date.parse('2026-07-29T15:10:00.000Z')}
      />
    )

    expect(html).toContain('1 active edit')
    expect(html).toContain('src/app.ts · lines 18–29')
    expect(html).toContain('Builder · Codex · Ship 1.9.2 · lane lane-1')
    expect(html).toContain('Worktree builder · current · codex/lock-ui')
    expect(html).toContain('/worktrees/builder')
    expect(html).toContain('Based on repo · /repo')
    expect(html).toContain('10m')
    expect(html).not.toContain('8821')
    expect(html).not.toContain('private-birth')
  })

  it('uses calm recovery wording and exposes recovered history separately', () => {
    const snapshot = createWorkLockProjectionSnapshot({
      generation: 4,
      sampledAt: '2026-07-29T15:10:00.000Z',
      locks: [
        lock({ lockId: 'paused', status: 'recovery_blocked' }),
        lock({ lockId: 'recovered', status: 'recovered' })
      ]
    })
    const html = renderToStaticMarkup(
      <WorkspaceLockPillView
        snapshot={snapshot}
        nowMs={Date.parse('2026-07-29T15:10:00.000Z')}
        onForceRelease={() => undefined}
        recoveryMessage="Recovery requires a restart."
      />
    )

    expect(html).toContain('1 active edit')
    expect(html).toContain('1 recovered')
    expect(html).toContain('Recovery paused')
    expect(html).toContain('Recovered safely')
    expect(html).toContain('kept this edit protected')
    expect(html).toContain('Review force release…')
    expect(html).toContain('Recovery requires a restart.')
    expect(html.toLowerCase()).not.toContain('conflict')
  })

  it('keeps the restart-required recovery result visible after the lock disappears', () => {
    const html = renderToStaticMarkup(
      <WorkspaceLockPillView
        snapshot={createWorkLockProjectionSnapshot({
          generation: 5,
          sampledAt: '2026-07-29T15:10:00.000Z',
          locks: []
        })}
        recoveryMessage="The approved acquisition was released durably. Restart TaskWraith."
      />
    )

    expect(html).toContain('workspace-lock-recovery-result--standalone')
    expect(html).toContain('Restart TaskWraith.')
  })

  it('renders nothing for an empty projection', () => {
    const html = renderToStaticMarkup(<WorkspaceLockPillView snapshot={null} />)
    expect(html).toBe('')
  })

  it('is mounted beside the composer worktree trigger with bounded popover CSS', () => {
    const composer = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/ComposerBranchWorktreePopover.tsx'),
      'utf8'
    )
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/WorkspaceLockPill.css'),
      'utf8'
    )

    expect(composer).toContain('<WorkspaceLockPill')
    expect(composer).toContain('composerWorktreeSelection?.effectiveWorkspacePath || workspacePath')
    expect(css).toMatch(/\.workspace-lock-popover\s*\{[^}]*position: absolute;/s)
    expect(css).toMatch(/max-height: min\(25rem, calc\(100vh - 2rem\)\);/)
    expect(css).toMatch(/width: min\(24rem, calc\(100vw - 1\.5rem\)\);/)
  })
})
