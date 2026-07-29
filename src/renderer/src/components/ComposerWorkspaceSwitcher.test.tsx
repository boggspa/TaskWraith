import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '../../../main/store/types'
import {
  ComposerWorkspaceSwitcher,
  ComposerWorkspaceKnownRow,
  type ComposerWorkspaceKnownRowProps
} from './ComposerWorkspaceSwitcher'

const workspace: WorkspaceRecord = {
  id: 'ws-2',
  path: '/Users/me/Documents/Beta',
  displayName: 'Beta',
  lastOpenedAt: 2,
  createdAt: 1,
  pinned: false
}

function renderRow(overrides: Partial<ComposerWorkspaceKnownRowProps> = {}): string {
  return renderToStaticMarkup(
    <ComposerWorkspaceKnownRow
      workspace={workspace}
      isPrimary={false}
      isAttached={false}
      remoteEntries={[]}
      onMakePrimary={() => {}}
      onAddSecondary={() => {}}
      onRemoteChanged={() => {}}
      {...overrides}
    />
  )
}

function buttonTag(html: string, className: string): string {
  return html.match(new RegExp(`<button[^>]*class="[^"]*${className}[^"]*"[^>]*>`))?.[0] || ''
}

describe('ComposerWorkspaceKnownRow', () => {
  it('makes the workspace name the primary switch action and places add at the trailing action slot', () => {
    const html = renderRow()
    const main = buttonTag(html, 'composer-workspace-known-main')
    const add = buttonTag(html, 'composer-workspace-known-add')

    expect(html).toMatch(
      /composer-workspace-known-row[^>]*><button[^>]*composer-workspace-known-main/
    )
    expect(main).toContain('aria-label="Switch primary workspace to Beta"')
    expect(main).not.toContain('disabled')
    expect(add).toContain('segmented-control-action--compact')
    expect(add).toContain('aria-label="Add Beta as secondary workspace"')
    expect(add).not.toContain('disabled')
    expect(html.indexOf('composer-workspace-known-main')).toBeLessThan(
      html.indexOf('composer-workspace-known-add')
    )
    expect(html).not.toContain('>Switch</button>')
  })

  it('preserves primary-row semantics and disables its inapplicable add action', () => {
    const html = renderRow({ isPrimary: true })

    expect(buttonTag(html, 'composer-workspace-known-main')).toContain('disabled=""')
    expect(buttonTag(html, 'composer-workspace-known-main')).toContain('aria-current="true"')
    expect(buttonTag(html, 'composer-workspace-known-add')).toContain('disabled=""')
    expect(html).toContain('composer-workspace-badge-primary')
    expect(html).toContain('>primary</span>')
  })

  it('keeps detach separate and disables add for an already-attached workspace', () => {
    const html = renderRow({ isAttached: true, onDetach: () => {} })

    expect(buttonTag(html, 'composer-workspace-known-main')).not.toContain('disabled')
    expect(buttonTag(html, 'composer-workspace-known-add')).toContain('disabled=""')
    expect(html).toContain('composer-workspace-badge-attached')
    expect(html).toContain('>Detach</button>')
  })

  it('shows a pending primary target without presenting it as already active', () => {
    const html = renderRow({ isPending: true })

    expect(buttonTag(html, 'composer-workspace-known-main')).toContain('disabled=""')
    expect(buttonTag(html, 'composer-workspace-known-main')).toContain(
      'aria-label="Beta, pending primary workspace"'
    )
    expect(html).toContain('is-pending')
    expect(html).toContain('>pending</span>')
    expect(html).not.toContain('aria-current="true"')
  })

  it('lets the current primary cancel a different pending target', () => {
    const html = renderRow({ isPrimary: true, canCancelPending: true })
    const main = buttonTag(html, 'composer-workspace-known-main')

    expect(main).not.toContain('disabled')
    expect(main).toContain('aria-label="Keep Beta as primary workspace"')
    expect(main).toContain('aria-current="true"')
    expect(main).toContain('cancel the pending workspace change')
  })
})

describe('ComposerWorkspaceSwitcher pending target', () => {
  it('surfaces the selected workspace immediately while preserving the current binding', () => {
    const current = {
      ...workspace,
      id: 'ws-1',
      path: '/Users/me/Documents/Alpha',
      displayName: 'Alpha'
    }
    const html = renderToStaticMarkup(
      <ComposerWorkspaceSwitcher
        workspaces={[current, workspace]}
        currentWorkspace={current}
        pendingWorkspace={workspace}
        onPickExisting={() => {}}
        onAddNewWorkspace={() => {}}
        onSelectNoWorkspace={() => {}}
      />
    )

    expect(html).toContain('data-pending-workspace="true"')
    expect(html).toContain('Pending: Beta')
    expect(html).toContain('Pending workspace change · Beta (currently Alpha)')
  })
})
