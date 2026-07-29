import { describe, expect, it } from 'vitest'
import type { ChatRecord } from './store/types'
import {
  clearPendingWorkspaceRebind,
  queuePendingWorkspaceRebind,
  readPendingWorkspaceRebind
} from './pendingWorkspaceRebind'

function chat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'codex',
    title: 'Workspace task',
    scope: 'workspace',
    workspaceId: 'ws-1',
    workspacePath: '/repo/one',
    providerMetadata: { selectedModelType: 'gpt-5.6' },
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  }
}

describe('pendingWorkspaceRebind', () => {
  it('queues a validated workspace target without changing the active binding', () => {
    const source = chat()
    const queued = queuePendingWorkspaceRebind(source, {
      schemaVersion: 1,
      scope: 'workspace',
      workspaceId: 'ws-2',
      workspacePath: '/repo/two',
      queuedAt: '2026-07-29T00:00:00.000Z'
    })

    expect(queued).toMatchObject({
      workspaceId: 'ws-1',
      workspacePath: '/repo/one',
      providerMetadata: {
        selectedModelType: 'gpt-5.6',
        pendingWorkspaceRebind: {
          workspaceId: 'ws-2',
          workspacePath: '/repo/two'
        }
      }
    })
    expect(readPendingWorkspaceRebind(queued)).toMatchObject({
      scope: 'workspace',
      workspaceId: 'ws-2',
      workspacePath: '/repo/two'
    })
  })

  it('rejects malformed stored targets and clears only pending control state', () => {
    const malformed = {
      ...chat(),
      providerMetadata: {
        selectedModelType: 'gpt-5.6',
        pendingWorkspaceRebind: {
          schemaVersion: 1,
          scope: 'workspace',
          workspaceId: 'ws-2',
          workspacePath: ''
        }
      }
    }

    expect(readPendingWorkspaceRebind(malformed)).toBeNull()
    expect(clearPendingWorkspaceRebind(malformed).providerMetadata).toEqual({
      selectedModelType: 'gpt-5.6'
    })
  })
})
