import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  createWorkLockProjectionSnapshot,
  type WorkLockProjectionSource,
  workspaceLockRecoveryMessage
} from '../../../shared/workLockProjection'
import { WorkspaceLockPillView } from './WorkspaceLockPill'
import { resolveWorkspaceLockPopoverPosition } from '../lib/workspaceLockPopoverPosition'

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
  it('hides resolved release notices while retaining actionable recovery feedback', () => {
    expect(
      workspaceLockRecoveryMessage({
        ok: true,
        releasedLeaseCount: 1,
        attentionRequired: false,
        message: 'Write-capable runs can start immediately.'
      })
    ).toBeNull()
    expect(
      workspaceLockRecoveryMessage({
        ok: true,
        releasedLeaseCount: 1,
        attentionRequired: true,
        message: 'Restart TaskWraith.'
      })
    ).toBe('Restart TaskWraith.')
    expect(
      workspaceLockRecoveryMessage({
        ok: false,
        reason: 'release_failed',
        message: 'The acquisition remains protected.'
      })
    ).toBe('The acquisition remains protected.')
  })

  it('renders a compact satellite trigger for active workspace edits', () => {
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
    expect(html).toContain('digit-odometer')
    expect(html).toContain('workspace-lock-trigger')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    // The trigger is text-only: no status dot at rest — recovery attention
    // tints the label instead (pinned against the CSS below).
    expect(html).not.toContain('workspace-lock-pill-dot')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('<details')
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
    expect(html).toContain('workspace-lock-trigger')
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

  it('keeps a zero-count odometer fixture visible for an empty projection', () => {
    const html = renderToStaticMarkup(<WorkspaceLockPillView snapshot={null} />)

    expect(html).toContain('0 active edits')
    expect(html).toContain('digit-odometer')
    expect(html).toContain('workspace-lock-trigger')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('aria-haspopup')
  })

  it('keeps recovered-only details inspectable while reporting zero active edits', () => {
    const snapshot = createWorkLockProjectionSnapshot({
      generation: 6,
      sampledAt: '2026-07-29T15:10:00.000Z',
      locks: [lock({ status: 'recovered' })]
    })
    const html = renderToStaticMarkup(
      <WorkspaceLockPillView snapshot={snapshot} nowMs={Date.parse('2026-07-29T15:10:00.000Z')} />
    )

    expect(html).toContain('0 active edits')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('disabled=""')
  })

  it('uses the available viewport space above the composer before falling below the trigger', () => {
    expect(
      resolveWorkspaceLockPopoverPosition({
        triggerRect: { left: 490, top: 620, bottom: 640, width: 80 },
        viewportWidth: 1_000,
        viewportHeight: 800
      })
    ).toEqual({ left: 338, top: 612, width: 384, maxHeight: 400, placement: 'above' })
    expect(
      resolveWorkspaceLockPopoverPosition({
        triggerRect: { left: 2, top: 120, bottom: 140, width: 20 },
        viewportWidth: 320,
        viewportHeight: 300
      })
    ).toEqual({ left: 8, top: 148, width: 304, maxHeight: 144, placement: 'below' })
  })

  it('is mounted beside PR/CI in the timecode bar with a portaled, satellite-style popover', () => {
    const composer = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/Composer.tsx'),
      'utf8'
    )
    const worktreePopover = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/ComposerBranchWorktreePopover.tsx'),
      'utf8'
    )
    const lockPill = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/WorkspaceLockPill.tsx'),
      'utf8'
    )
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/WorkspaceLockPill.css'),
      'utf8'
    )

    expect(composer).toContain('<WorkspaceLockPill')
    expect(composer).toContain('composer-thread-timecode-satellites')
    expect(composer).toContain(
      'currentWorkspace ? (\n                    <div className="composer-thread-timecode-satellites">'
    )
    expect(composer).toContain(
      '{showWorkspaceGitAboveRows && (\n                        <GitHubSatelliteRow'
    )
    expect(composer).toContain(
      'composerWorktreeSelection?.effectiveWorkspacePath ||\n                          composerGitActionBasePath ||\n                          currentWorkspace.path'
    )
    expect(worktreePopover).not.toContain('<WorkspaceLockPill')
    expect(lockPill).toContain('createPortal')
    expect(lockPill).toContain('document.body')
    expect(css).toMatch(/\.workspace-lock-popover\s*\{[^}]*position: fixed;/s)
    expect(css).toMatch(/\.workspace-lock-trigger\s*\{[^}]*border: 0;/s)
    expect(css).toMatch(/background: var\(--tw-popover-glass-bg\);/)
    expect(css).toMatch(/box-shadow: var\(--tw-popover-material-shadow\);/)
    expect(css).toMatch(/backdrop-filter: var\(--tw-popover-material-backdrop\);/)
    expect(css).toMatch(/-webkit-backdrop-filter: var\(--tw-popover-material-backdrop\);/)
    expect(css).toMatch(/isolation: isolate;/)
    expect(css).toMatch(/max-height: min\(25rem, calc\(100vh - 2rem\)\);/)
    expect(css).toMatch(/width: min\(24rem, calc\(100vw - 1\.5rem\)\);/)
    // The trigger dot is gone for good; the popover row dots stay, and the
    // recovery-attention state now tints the trigger text instead.
    expect(css).not.toContain('.workspace-lock-pill-dot')
    expect(css).toContain('.workspace-lock-status-dot')
    expect(css).toMatch(/\.workspace-lock-trigger\.has-recovery-attention\s*\{[^}]*var\(--warning/s)
  })
})
