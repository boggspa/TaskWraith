import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_VISIBLE_TERMINAL_SESSIONS, keepVisibleTerminalSessions } from './TerminalWorkbench'

const workbenchSource = readFileSync(new URL('./TerminalWorkbench.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')

describe('TerminalWorkbench persistent sessions', () => {
  it('bounds visible panes without dropping the background session contract', () => {
    const sessions = Array.from({ length: MAX_VISIBLE_TERMINAL_SESSIONS }, (_, index) => ({
      sessionId: `session-${index + 1}`,
      workspacePath: `/work/${index + 1}`
    }))
    const next = keepVisibleTerminalSessions(sessions, {
      sessionId: 'session-5',
      workspacePath: '/work/5'
    })

    expect(next.map((session) => session.sessionId)).toEqual([
      'session-2',
      'session-3',
      'session-4',
      'session-5'
    ])
    expect(workbenchSource).not.toContain('terminal.kill(oldestSession')
    expect(workbenchSource).toContain('window.api.terminal.detach(sessionId)')
  })

  it('routes New Terminal Session through the shared CLI picker', () => {
    expect(workbenchSource).toContain('<TerminalSessionPicker')
    expect(workbenchSource).toContain('window.api.terminal.create(workspacePath, sessionId, cliId)')
    expect(sidebarSource).toContain('terminalLaunchBus.request(wsPath)')
  })
})
