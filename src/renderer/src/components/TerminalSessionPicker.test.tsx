import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceRecord } from '../../../main/store/types'
import { TERMINAL_CLI_IDS } from '../../../shared/terminalCli'
import { TERMINAL_CLI_OPTIONS, TerminalSessionPicker } from './TerminalSessionPicker'

const workspace = (id: string): WorkspaceRecord => ({
  id,
  displayName: `${id} workspace`,
  path: `/work/${id}`,
  createdAt: 1,
  lastOpenedAt: 1,
  pinned: false
})

describe('TerminalSessionPicker', () => {
  it('offers every supported native CLI from one shared catalogue', () => {
    expect(TERMINAL_CLI_OPTIONS.map((option) => option.id)).toEqual([...TERMINAL_CLI_IDS])

    const html = renderToStaticMarkup(
      <TerminalSessionPicker workspaces={[workspace('alpha')]} onSelect={vi.fn()} />
    )
    for (const option of TERMINAL_CLI_OPTIONS) {
      expect(html).toContain(`<strong>${option.label}</strong>`)
    }
    expect(html).toContain('Native CLI Quickload')
    expect(html).toContain('Normal Terminal in Workspace')
  })

  it('puts the current workspace first without hiding the rest', () => {
    const html = renderToStaticMarkup(
      <TerminalSessionPicker
        workspaces={[workspace('alpha'), workspace('beta'), workspace('gamma')]}
        preferredWorkspacePath="/work/gamma"
        onSelect={vi.fn()}
      />
    )

    expect(html.indexOf('gamma workspace')).toBeLessThan(html.indexOf('alpha workspace'))
    expect(html).toContain('beta workspace')
  })
})
