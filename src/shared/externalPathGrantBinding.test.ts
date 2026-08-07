import { describe, expect, it } from 'vitest'
import {
  chatGrantWorkspaceBindingFromChat,
  sameChatGrantWorkspaceBinding
} from './externalPathGrantBinding'

describe('sameChatGrantWorkspaceBinding', () => {
  it('fails closed when the stamped primary is missing (legacy / incomplete consent)', () => {
    expect(
      sameChatGrantWorkspaceBinding(
        {},
        { scope: 'workspace', workspaceId: 'ws-1', workspacePath: '/ws-1' }
      )
    ).toBe(false)
  })

  it('matches when chat primary is unchanged since consent', () => {
    const stamped = chatGrantWorkspaceBindingFromChat({
      scope: 'workspace',
      workspaceId: 'ws-1',
      workspacePath: '/ws-1'
    })
    expect(
      sameChatGrantWorkspaceBinding(stamped, {
        scope: 'workspace',
        workspaceId: 'ws-1',
        workspacePath: '/ws-1'
      })
    ).toBe(true)
  })

  it('fails closed when the chat primary rebinds while the approval modal is open', () => {
    // Regression: agent-approval Accept reminted onto the new primary; pick-and-persist
    // already cancelled in this case.
    const stamped = chatGrantWorkspaceBindingFromChat({
      scope: 'workspace',
      workspaceId: 'ws-1',
      workspacePath: '/ws-1'
    })
    expect(
      sameChatGrantWorkspaceBinding(stamped, {
        scope: 'workspace',
        workspaceId: 'ws-2',
        workspacePath: '/ws-2'
      })
    ).toBe(false)
  })

  it('fails closed on path-only or id-only primary drift', () => {
    const stamped = chatGrantWorkspaceBindingFromChat({
      scope: 'workspace',
      workspaceId: 'ws-1',
      workspacePath: '/ws-1'
    })
    expect(
      sameChatGrantWorkspaceBinding(stamped, {
        scope: 'workspace',
        workspaceId: 'ws-1',
        workspacePath: '/ws-1b'
      })
    ).toBe(false)
    expect(
      sameChatGrantWorkspaceBinding(stamped, {
        scope: 'workspace',
        workspaceId: 'ws-2',
        workspacePath: '/ws-1'
      })
    ).toBe(false)
  })

  it('fails closed when scope flips between workspace and global', () => {
    expect(
      sameChatGrantWorkspaceBinding(
        { workspaceScope: 'workspace', workspaceId: 'ws-1', workspacePath: '/ws-1' },
        { scope: 'global' }
      )
    ).toBe(false)
    expect(
      sameChatGrantWorkspaceBinding(
        { workspaceScope: 'global' },
        {
          scope: 'workspace',
          workspaceId: 'ws-1',
          workspacePath: '/ws-1'
        }
      )
    ).toBe(false)
  })

  it('treats trimmed id/path equivalents as the same binding', () => {
    expect(
      sameChatGrantWorkspaceBinding(
        { workspaceScope: 'workspace', workspaceId: ' ws-1 ', workspacePath: ' /ws-1 ' },
        { scope: 'workspace', workspaceId: 'ws-1', workspacePath: '/ws-1' }
      )
    ).toBe(true)
  })

  it('matches global-scope chats without requiring workspace ids', () => {
    expect(sameChatGrantWorkspaceBinding({ workspaceScope: 'global' }, { scope: 'global' })).toBe(
      true
    )
  })
})
