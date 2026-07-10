import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '../../../main/store/types'
import {
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
})
