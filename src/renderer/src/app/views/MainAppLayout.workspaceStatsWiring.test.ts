import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const layoutSource = readFileSync(new URL('./MainAppLayout.tsx', import.meta.url), 'utf8')

describe('MainAppLayout Workspace Stats wiring', () => {
  it('keeps the composer request local to its sibling action pill', () => {
    expect(layoutSource).toContain(
      'const mainPaneActionPillRef = useRef<MainPaneActionPillHandle>(null)'
    )
    expect(layoutSource).toContain('() => mainPaneActionPillRef.current?.openWorkspaceStats()')
    expect(layoutSource).toContain('ref={mainPaneActionPillRef}')
    expect(layoutSource).toContain(
      'canOpenMainPaneWorkspaceStats ? requestMainPaneWorkspaceStats : undefined'
    )
  })

  it('does not offer the request where the Stats pill is absent', () => {
    const compactComposerStart = layoutSource.indexOf('<CompactChatComposer')
    const compactComposerEnd = layoutSource.indexOf('/>', compactComposerStart)

    expect(layoutSource).toContain('!isChatPopoutWindow && Boolean(mainPaneWorkspaceStats)')
    expect(layoutSource).toMatch(
      /<Composer\s+\{\.\.\.composerCtx\}\s+onOpenWorkspaceStats=\{[\s\S]*?canOpenMainPaneWorkspaceStats/
    )
    expect(compactComposerStart).toBeGreaterThan(-1)
    expect(compactComposerEnd).toBeGreaterThan(compactComposerStart)
    expect(layoutSource.slice(compactComposerStart, compactComposerEnd)).not.toContain(
      'onOpenWorkspaceStats'
    )
  })
})
