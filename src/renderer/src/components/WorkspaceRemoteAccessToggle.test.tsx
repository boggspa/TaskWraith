import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '../../../main/store/types'
import type { RemoteWorkspaceEntry } from '../../../shared/remoteWorkspaceDefaults'
import { WorkspaceRemoteAccessToggle } from './WorkspaceRemoteAccessToggle'

const workspace: WorkspaceRecord = {
  id: 'ws-1',
  path: '/Users/me/Documents/Repo',
  displayName: 'Repo',
  lastOpenedAt: 0,
  createdAt: 0,
  pinned: false
}

function entry(overrides: Partial<RemoteWorkspaceEntry> = {}): RemoteWorkspaceEntry {
  return {
    workspaceId: 'ws-1',
    path: '/Users/me/Documents/Repo',
    mode: 'read-only',
    allowedProviders: ['claude'],
    allowedApprovalModes: ['plan'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function render(entries: RemoteWorkspaceEntry[]): string {
  return renderToStaticMarkup(<WorkspaceRemoteAccessToggle workspace={workspace} entries={entries} />)
}

// Active segment = the <button> carrying both is-active and its data-segment.
function activeSegment(html: string): string | null {
  const match = html.match(/<button[^>]*class="[^"]*is-active[^"]*"[^>]*data-segment="([^"]+)"/)
  if (match) return match[1]
  const alt = html.match(/<button[^>]*data-segment="([^"]+)"[^>]*class="[^"]*is-active[^"]*"/)
  return alt ? alt[1] : null
}

describe('WorkspaceRemoteAccessToggle', () => {
  it('renders all three segments with a per-workspace radiogroup label', () => {
    const html = render([])
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-label="Remote access for Repo"')
    expect(html).toContain('data-segment="off"')
    expect(html).toContain('data-segment="read"')
    expect(html).toContain('data-segment="read-write"')
  })

  it('shows Off active when the workspace has no allowlist entry', () => {
    expect(activeSegment(render([]))).toBe('off')
  })

  it('shows Read active for a read-only entry', () => {
    expect(activeSegment(render([entry({ mode: 'read-only' })]))).toBe('read')
  })

  it('shows Read/Write active for a read-write entry with file caps', () => {
    const html = render([
      entry({ mode: 'read-write', capabilities: ['monitor', 'fileBrowse', 'fileRead', 'fileWrite'] })
    ])
    expect(activeSegment(html)).toBe('read-write')
    expect(html).not.toContain('files off')
  })

  it('flags a legacy read-write entry (no file caps) as files off, not full Read/Write', () => {
    const html = render([entry({ mode: 'read-write', capabilities: undefined })])
    expect(activeSegment(html)).toBe('read-write')
    expect(html).toContain('files off')
  })

  it('treats an expired entry as Off', () => {
    const html = render([entry({ mode: 'read-write', expiresAt: 1 })])
    expect(activeSegment(html)).toBe('off')
  })
})
