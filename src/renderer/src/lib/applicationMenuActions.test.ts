import { describe, expect, it, vi } from 'vitest'
import {
  resolveApplicationMenuWorkspace,
  runApplicationMenuCommand,
  type ApplicationMenuActions
} from './applicationMenuActions'

function actions(activeTab: ApplicationMenuActions['activeTab']): ApplicationMenuActions {
  return {
    activeTab,
    workspace: { id: 'workspace-1', path: '/work/project' },
    newWorkspaceChat: vi.fn(),
    newGlobalChat: vi.fn(),
    newTerminal: vi.fn(),
    openFolder: vi.fn(),
    openGeneralSettings: vi.fn(),
    showApp: vi.fn()
  }
}

describe('application menu renderer actions', () => {
  it('uses the project preference, current workspace, then the most recently opened workspace', () => {
    const first = { id: 'first', path: '/first', lastOpenedAt: 1 }
    const recent = { id: 'recent', path: '/recent', lastOpenedAt: 2 }
    expect(resolveApplicationMenuWorkspace([first, recent], recent, 'first')).toBe(first)
    expect(resolveApplicationMenuWorkspace([first, recent], first)).toBe(first)
    expect(resolveApplicationMenuWorkspace([first, recent], null)).toBe(recent)
    expect(resolveApplicationMenuWorkspace([], null)).toBeNull()
  })
  it.each(['projects', 'threads'] as const)('creates a workspace chat in %s', (tab) => {
    const target = actions(tab)
    runApplicationMenuCommand('new-chat', target)
    expect(target.newWorkspaceChat).toHaveBeenCalledExactlyOnceWith('workspace-1', '/work/project')
    expect(target.newGlobalChat).not.toHaveBeenCalled()
  })

  it('creates a global chat in Chat', () => {
    const target = actions('chat')
    runApplicationMenuCommand('new-chat', target)
    expect(target.newGlobalChat).toHaveBeenCalledOnce()
    expect(target.newWorkspaceChat).not.toHaveBeenCalled()
  })

  it('opens the existing terminal session picker in the Terminal tab', () => {
    const target = actions('terminal')
    runApplicationMenuCommand('new-chat', target)
    expect(target.newTerminal).toHaveBeenCalledExactlyOnceWith('/work/project')
    expect(target.newGlobalChat).not.toHaveBeenCalled()
  })

  it('asks for a workspace when Projects has no selection', () => {
    const target = { ...actions('projects'), workspace: null }
    runApplicationMenuCommand('new-chat', target)
    expect(target.openFolder).toHaveBeenCalledOnce()
    expect(target.newGlobalChat).not.toHaveBeenCalled()
  })

  it('opens General settings or the normal folder flow independently of the current tab', () => {
    const target = actions('terminal')
    runApplicationMenuCommand('settings', target)
    expect(target.openGeneralSettings).toHaveBeenCalledOnce()
    expect(target.showApp).not.toHaveBeenCalled()
    runApplicationMenuCommand('open-folder', target)
    expect(target.showApp).toHaveBeenCalledOnce()
    expect(target.openFolder).toHaveBeenCalledOnce()
  })
})
