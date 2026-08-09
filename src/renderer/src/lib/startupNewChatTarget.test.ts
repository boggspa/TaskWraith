import { describe, expect, it } from 'vitest'

import {
  LAST_ACTIVE_WORK_PROJECT_STORAGE_KEY,
  LAST_ACTIVE_WORKSPACE_STORAGE_KEY,
  readColdLaunchNewChatContext,
  rememberLastActiveWorkProjectId,
  rememberLastActiveWorkspaceId,
  rememberSidebarActiveTab,
  resolveColdLaunchNewChatTarget,
  SIDEBAR_ACTIVE_TAB_STORAGE_KEY,
  type StartupContextStorage
} from './startupNewChatTarget'

function memoryStorage(initial: Record<string, string> = {}): StartupContextStorage {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}

const workspaces = [
  { id: 'ws-old', path: '/repos/old', lastOpenedAt: 10 },
  { id: 'ws-last', path: '/repos/last', lastOpenedAt: 20 },
  { id: 'ws-preferred', path: '/repos/preferred', lastOpenedAt: 5 }
]

describe('cold-launch New Chat context', () => {
  it('round-trips the last surface, workspace, and Work project', () => {
    const storage = memoryStorage()

    rememberSidebarActiveTab('projects', storage)
    rememberLastActiveWorkspaceId('ws-last', storage)
    rememberLastActiveWorkProjectId('project-a', storage)

    expect(readColdLaunchNewChatContext(storage)).toEqual({
      activeTab: 'projects',
      workspaceId: 'ws-last',
      projectId: 'project-a'
    })
  })

  it('sanitizes invalid or cleared renderer memory', () => {
    const storage = memoryStorage({
      [SIDEBAR_ACTIVE_TAB_STORAGE_KEY]: 'unknown',
      [LAST_ACTIVE_WORKSPACE_STORAGE_KEY]: '  ',
      [LAST_ACTIVE_WORK_PROJECT_STORAGE_KEY]: ' project-a '
    })

    rememberLastActiveWorkProjectId(null, storage)

    expect(readColdLaunchNewChatContext(storage)).toEqual({
      activeTab: 'chat',
      workspaceId: null,
      projectId: null
    })
  })
})

describe('resolveColdLaunchNewChatTarget', () => {
  it('keeps Chat on a pristine General draft', () => {
    expect(
      resolveColdLaunchNewChatTarget({
        context: { activeTab: 'chat', workspaceId: 'ws-last', projectId: 'project-a' },
        workspaces,
        projects: [{ id: 'project-a' }],
        projectProfiles: [{ projectId: 'project-a', preferredWorkspaceId: 'ws-preferred' }]
      })
    ).toEqual({ surface: 'chat', workspace: null, projectId: null })
  })

  it('opens Code in the explicitly remembered workspace', () => {
    expect(
      resolveColdLaunchNewChatTarget({
        context: { activeTab: 'threads', workspaceId: 'ws-old', projectId: null },
        workspaces,
        projects: [],
        projectProfiles: []
      })
    ).toEqual({ surface: 'threads', workspace: workspaces[0], projectId: null })
  })

  it('falls back to the most recently opened workspace when Code memory is stale', () => {
    expect(
      resolveColdLaunchNewChatTarget({
        context: { activeTab: 'threads', workspaceId: 'ws-gone', projectId: null },
        workspaces,
        projects: [],
        projectProfiles: []
      })
    ).toEqual({ surface: 'threads', workspace: workspaces[1], projectId: null })
  })

  it('opens Work on a project-member draft in its preferred workspace', () => {
    expect(
      resolveColdLaunchNewChatTarget({
        context: { activeTab: 'projects', workspaceId: 'ws-last', projectId: 'project-a' },
        workspaces,
        projects: [{ id: 'project-a' }],
        projectProfiles: [{ projectId: 'project-a', preferredWorkspaceId: 'ws-preferred' }]
      })
    ).toEqual({
      surface: 'projects',
      workspace: workspaces[2],
      projectId: 'project-a'
    })
  })

  it('uses General for a valid Work project with no preferred workspace', () => {
    expect(
      resolveColdLaunchNewChatTarget({
        context: { activeTab: 'projects', workspaceId: 'ws-last', projectId: 'project-a' },
        workspaces,
        projects: [{ id: 'project-a' }],
        projectProfiles: []
      })
    ).toEqual({ surface: 'projects', workspace: null, projectId: 'project-a' })
  })

  it('does not attach a draft to an archived or vanished Work project', () => {
    expect(
      resolveColdLaunchNewChatTarget({
        context: { activeTab: 'projects', workspaceId: null, projectId: 'project-archived' },
        workspaces,
        projects: [{ id: 'project-archived', archived: true }],
        projectProfiles: [{ projectId: 'project-archived', preferredWorkspaceId: 'ws-preferred' }]
      })
    ).toEqual({ surface: 'projects', workspace: null, projectId: null })
  })
})
