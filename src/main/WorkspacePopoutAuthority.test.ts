import { describe, expect, it } from 'vitest'
import {
  assertWorkspacePopoutChatRequestWithinOwner,
  assertWorkspacePopoutRequestWithinOwner
} from './WorkspacePopoutAuthority'

const canonicalize = (value: string): string => value.replace(/\/$/, '')

describe('assertWorkspacePopoutRequestWithinOwner', () => {
  it('lets a chat popout open a child view in its own workspace', () => {
    expect(() =>
      assertWorkspacePopoutRequestWithinOwner(
        { kind: 'chat', chatId: 'chat-a', workspacePath: '/workspace/a' },
        { kind: 'diff-studio', chatId: 'chat-a', workspacePath: '/workspace/a/' },
        canonicalize
      )
    ).not.toThrow()
  })

  it('does not let a chat or diff popout mint an editor or workbench capability', () => {
    for (const ownerKind of ['chat', 'diff-studio'] as const) {
      for (const requestedKind of ['file-editor', 'workbench'] as const) {
        expect(() =>
          assertWorkspacePopoutRequestWithinOwner(
            { kind: ownerKind, chatId: 'chat-a', workspacePath: '/workspace/a' },
            { kind: requestedKind, chatId: 'chat-a', workspacePath: '/workspace/a' },
            canonicalize
          )
        ).toThrow('Renderer cannot open a popout with broader authority.')
      }
    }
  })

  it('does not let a utility popout mint chat authority from a matching chat id', () => {
    expect(() =>
      assertWorkspacePopoutRequestWithinOwner(
        { kind: 'diff-studio', chatId: 'chat-a', workspacePath: '/workspace/a' },
        { kind: 'chat', chatId: 'chat-a', workspacePath: '/workspace/a' },
        canonicalize
      )
    ).toThrow('Renderer cannot open a popout with broader authority.')
  })

  it('allows an existing write-capable surface to open sibling write and diff views', () => {
    for (const requestedKind of ['file-editor', 'workbench', 'diff-studio'] as const) {
      expect(() =>
        assertWorkspacePopoutRequestWithinOwner(
          { kind: 'workbench', workspacePath: '/workspace/a' },
          { kind: requestedKind, workspacePath: '/workspace/a' },
          canonicalize
        )
      ).not.toThrow()
    }
  })

  it('rejects a popout attempting to mint authority for another registered workspace', () => {
    expect(() =>
      assertWorkspacePopoutRequestWithinOwner(
        { kind: 'workbench', workspacePath: '/workspace/a' },
        { kind: 'diff-studio', workspacePath: '/workspace/b' },
        canonicalize
      )
    ).toThrow('Renderer cannot open a popout for another workspace.')
  })

  it('rejects a popout attempting to open another chat', () => {
    expect(() =>
      assertWorkspacePopoutRequestWithinOwner(
        { kind: 'chat', chatId: 'chat-a', workspacePath: '/workspace/a' },
        { kind: 'chat', chatId: 'chat-b', workspacePath: '/workspace/a' },
        canonicalize
      )
    ).toThrow('Renderer cannot open a chat outside its popout authority.')
  })

  it('rejects a global chat popout attempting to acquire workspace authority', () => {
    expect(() =>
      assertWorkspacePopoutRequestWithinOwner(
        { kind: 'chat', chatId: 'chat-a' },
        { kind: 'workbench', chatId: 'chat-a', workspacePath: '/workspace/a' },
        canonicalize
      )
    ).toThrow('Renderer has no workspace authority for this popout request.')
  })
})

describe('assertWorkspacePopoutChatRequestWithinOwner', () => {
  it('allows the owning chat popout and rejects a cross-chat request', () => {
    const owner = { kind: 'chat' as const, chatId: 'chat-a', workspacePath: '/workspace/a' }
    expect(() => assertWorkspacePopoutChatRequestWithinOwner(owner, 'chat-a')).not.toThrow()
    expect(() => assertWorkspacePopoutChatRequestWithinOwner(owner, 'chat-b')).toThrow(
      'Renderer cannot act on another chat.'
    )
  })

  it('does not let a workspace utility popout dispatch a chat run', () => {
    expect(() =>
      assertWorkspacePopoutChatRequestWithinOwner(
        { kind: 'workbench', chatId: 'chat-a', workspacePath: '/workspace/a' },
        'chat-a'
      )
    ).toThrow('Renderer cannot act on another chat.')
  })
})
