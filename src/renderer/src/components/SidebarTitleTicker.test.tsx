import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SidebarTitleTicker } from './SidebarTitleTicker'

function render(
  props: Partial<{
    identity: string
    branch: string | null
    gitIndicators: string | null
    className: string
  }> = {}
): string {
  return renderToStaticMarkup(
    <SidebarTitleTicker
      identity={props.identity ?? 'TaskWraith/master'}
      branch={props.branch === undefined ? 'master' : props.branch}
      gitIndicators={props.gitIndicators === undefined ? null : props.gitIndicators}
      className={props.className ?? 'sidebar-thread-title'}
    >
      <span className="title-child">Design notes</span>
    </SidebarTitleTicker>
  )
}

describe('SidebarTitleTicker identity face', () => {
  it('splits the branch off the identity suffix and tints only the branch', () => {
    const html = render({ identity: 'TaskWraith/master', branch: 'master' })
    // The repo half keeps the separator and stays in the row's own ink.
    expect(html).toContain('TaskWraith/')
    expect(html).toContain('class="sidebar-title-ticker-branch git-tone-main"')
    expect(html).toContain('>master</span>')
  })

  it('splits correctly when the branch itself contains a slash', () => {
    const html = render({ identity: 'org/repo/feat/awesome', branch: 'feat/awesome' })
    expect(html).toContain('org/repo/')
    expect(html).toContain('class="sidebar-title-ticker-branch git-tone-feature"')
    expect(html).toContain('>feat/awesome</span>')
  })

  it('derives the tone from the branch name rather than the position', () => {
    expect(render({ identity: 'w/fix/bug-1', branch: 'fix/bug-1' })).toContain('git-tone-fix')
    expect(render({ identity: 'w/topic', branch: 'topic' })).toContain('git-tone-other')
  })

  it('renders the plain identity when no branch is supplied', () => {
    const html = render({ identity: 'IsolatedWorkspace', branch: null })
    expect(html).toContain('IsolatedWorkspace')
    expect(html).not.toContain('sidebar-title-ticker-branch')
  })

  it('treats a whitespace-only branch as absent', () => {
    const html = render({ identity: 'IsolatedWorkspace', branch: '   ' })
    expect(html).not.toContain('sidebar-title-ticker-branch')
  })

  it('falls back to the plain identity when the branch is not its suffix', () => {
    // Belt-and-braces: disagreeing inputs must not mis-slice the name.
    const html = render({ identity: 'TaskWraith/main', branch: 'feature-x' })
    expect(html).toContain('TaskWraith/main')
    expect(html).not.toContain('sidebar-title-ticker-branch')
  })

  it('does not treat a bare substring match as a clean split', () => {
    // "master" is inside the identity but not after a "/" boundary.
    const html = render({ identity: 'remaster', branch: 'master' })
    expect(html).toContain('remaster')
    expect(html).not.toContain('sidebar-title-ticker-branch')
  })
})

describe('SidebarTitleTicker git indicator strip', () => {
  it('decodes and renders the encoded indicators', () => {
    const html = render({ gitIndicators: 'pushed' })
    expect(html).toContain('class="sidebar-git-indicators"')
    expect(html).toContain('kind-pushed')
  })

  it('carries the ahead count through the decode', () => {
    const html = render({ gitIndicators: 'ahead:3' })
    expect(html).toContain('kind-ahead')
    expect(html).toContain('3')
  })

  it('omits the strip entirely when no indicators are encoded', () => {
    expect(render({ gitIndicators: null })).not.toContain('sidebar-git-indicators')
    expect(render({ gitIndicators: '' })).not.toContain('sidebar-git-indicators')
  })
})

describe('SidebarTitleTicker shell', () => {
  it('appends the caller class to the ticker root and keeps children', () => {
    const html = render({ className: 'sidebar-thread-title' })
    expect(html).toContain('class="sidebar-title-ticker sidebar-thread-title"')
    expect(html).toContain('class="title-child"')
    expect(html).toContain('Design notes')
  })

  it('marks the identity face decorative so the row keeps its accessible name', () => {
    const html = render()
    expect(html).toContain('aria-hidden')
    expect(html).toContain('class="sidebar-title-ticker-seg sidebar-title-ticker-identity"')
  })
})
