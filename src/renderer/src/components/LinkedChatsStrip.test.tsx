import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { LinkedChatsStrip } from './LinkedChatsStrip'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'parent-1',
    scope: 'workspace',
    provider: 'gemini',
    title: 'Parent',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('LinkedChatsStrip', () => {
  it('renders direct side chats and subthreads under the active parent', () => {
    const parent = makeChat()
    const subThreadIdentity = assignAgentIdentityFromSeed('sub-1')
    const sideChat = makeChat({
      appChatId: 'side-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      provider: 'codex',
      title: 'Scratch beside parent',
      sideChatContext: {
        createdAt: 2,
        lifecycleState: 'active',
        originMessageId: 'message-1',
        mode: 'singleProvider',
        transcriptVisibility: 'selected'
      }
    })
    const subThread = makeChat({
      appChatId: 'sub-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'subThread',
      provider: 'claude',
      title: 'Investigate tests'
    })
    const archived = makeChat({
      appChatId: 'archived-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      title: 'Archived child',
      archived: true
    })
    const terminated = makeChat({
      appChatId: 'terminated-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      title: 'Terminated child',
      sideChatContext: {
        createdAt: 2,
        lifecycleState: 'terminated'
      }
    })
    const unrelated = makeChat({
      appChatId: 'other-1',
      parentChatId: 'other-parent',
      parentChatRelation: 'sideChat',
      title: 'Other child'
    })

    const html = renderToStaticMarkup(
      <LinkedChatsStrip
        currentChat={parent}
        chats={[parent, sideChat, subThread, archived, terminated, unrelated]}
        runningChatIds={['sub-1']}
        onOpenBeside={() => {}}
        onOpenDrawer={() => {}}
        onOpenMain={() => {}}
        onPopOut={() => {}}
      />
    )

    expect(html).toContain('Linked chats')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('2 linked | 1 running | 1 side chat | 1 sub-thread')
    expect(html).toContain('Isolated side chat')
    expect(html).toContain('Scratch beside parent')
    expect(html).toContain('Active')
    expect(html).toContain('Isolated sidecar')
    expect(html).toContain('Seeded from selected message')
    expect(html).toContain('Sub-thread')
    expect(html).toContain('Investigate tests')
    expect(html).toContain('Delegated child')
    expect(html).toContain('Delegation context')
    expect(html).toContain('Gemini side branch to Codex')
    expect(html).toContain('Gemini delegated to Claude')
    expect(html).toContain(subThreadIdentity.name)
    expect(html).toContain('linked-chats-strip-agent-icon')
    expect(html).toContain('Open drawer')
    expect(html).toContain('Open as main')
    expect(html).toContain('Pop out')
    expect(html).toContain('is-running')
    expect(html).not.toContain('Archived child')
    expect(html).not.toContain('Terminated child')
    expect(html).not.toContain('Other child')
  })

  it('does not render plain same-provider side chats as agent identities', () => {
    const parent = makeChat({
      provider: 'codex',
      title: 'Codex parent'
    })
    const plainSideChat = makeChat({
      appChatId: 'side-codex-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      provider: 'codex',
      title: 'Side Codex chat',
      sideChatContext: {
        createdAt: 2,
        lifecycleState: 'closed',
        mode: 'singleProvider',
        transcriptVisibility: 'none'
      }
    })

    const html = renderToStaticMarkup(
      <LinkedChatsStrip
        currentChat={parent}
        chats={[parent, plainSideChat]}
        runningChatIds={[]}
        onOpenBeside={() => {}}
      />
    )

    expect(html).toContain('Side Codex chat')
    expect(html).toContain('Isolated sidecar')
    expect(html).toContain('Codex isolated side chat')
    expect(html).not.toContain('Codex side branch to Codex')
    expect(html).not.toContain('linked-chats-strip-agent-icon')
  })

  it('can render the linked marker collapsed to a summary', () => {
    const parent = makeChat()
    const sideChat = makeChat({
      appChatId: 'side-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      provider: 'codex',
      title: 'Scratch beside parent'
    })
    const subThread = makeChat({
      appChatId: 'sub-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'subThread',
      provider: 'claude',
      title: 'Investigate tests'
    })

    const html = renderToStaticMarkup(
      <LinkedChatsStrip
        currentChat={parent}
        chats={[parent, sideChat, subThread]}
        runningChatIds={['sub-1']}
        onOpenBeside={() => {}}
        defaultCollapsed
      />
    )

    expect(html).toContain('Linked chats')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('2 linked | 1 running | 1 side chat | 1 sub-thread')
    expect(html).not.toContain('Scratch beside parent')
    expect(html).not.toContain('Investigate tests')
  })

  it('labels fan-out side chats distinctly from ensemble clones', () => {
    const parent = makeChat()
    const fanOut = makeChat({
      appChatId: 'fan-out-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      chatKind: 'ensemble',
      provider: 'gemini',
      title: 'Parallel branch',
      sideChatContext: {
        createdAt: 2,
        lifecycleState: 'active',
        mode: 'fanOut',
        transcriptVisibility: 'none'
      }
    })

    const html = renderToStaticMarkup(
      <LinkedChatsStrip
        currentChat={parent}
        chats={[parent, fanOut]}
        runningChatIds={[]}
        onOpenBeside={() => {}}
      />
    )

    expect(html).toContain('Fan-out side chat')
    expect(html).toContain('Fan-out')
    expect(html).toContain('Isolated context')
    expect(html).toContain('Gemini parallel fan-out')
  })

  it('labels participant-dedicated side chats with the selected participant', () => {
    const parent = makeChat()
    const participantIdentity = assignAgentIdentityFromSeed('parent-1:reviewer-codex')
    const participantSideChat = makeChat({
      appChatId: 'participant-side-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      provider: 'codex',
      title: 'Reviewer branch',
      sideChatContext: {
        createdAt: 2,
        lifecycleState: 'active',
        mode: 'singleProvider',
        transcriptVisibility: 'none'
      },
      providerMetadata: {
        sideChatSelectedParticipantId: 'reviewer-codex',
        sideChatSelectedParticipantRole: 'Reviewer'
      }
    })

    const html = renderToStaticMarkup(
      <LinkedChatsStrip
        currentChat={parent}
        chats={[parent, participantSideChat]}
        runningChatIds={[]}
        onOpenBeside={() => {}}
      />
    )

    expect(html).toContain('Isolated side chat')
    expect(html).toContain('Reviewer branch')
    expect(html).toContain('Participant: Reviewer')
    expect(html).toContain('Gemini dedicated branch to Reviewer')
    expect(html).toContain(participantIdentity.name)
    expect(html).toContain('linked-chats-strip-agent-icon')
  })

  it('renders historical guest side chats as inert linked chats', () => {
    const parent = makeChat()
    const supersededGuest = makeChat({
      appChatId: 'guest-old',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      provider: 'codex',
      title: 'Guest participant (codex)',
      sideChatContext: {
        createdAt: 2,
        lifecycleState: 'closed',
        mode: 'guestParticipant',
        transcriptVisibility: 'none'
      }
    })
    const currentGuest = makeChat({
      appChatId: 'guest-current',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      provider: 'cursor',
      title: 'Guest participant (cursor)',
      sideChatContext: {
        createdAt: 3,
        lifecycleState: 'closed',
        mode: 'guestParticipant',
        transcriptVisibility: 'none'
      }
    })

    const html = renderToStaticMarkup(
      <LinkedChatsStrip
        currentChat={parent}
        chats={[parent, supersededGuest, currentGuest]}
        runningChatIds={[]}
        onOpenBeside={() => {}}
      />
    )

    expect(html).toContain('2 linked | 2 guests')
    expect(html).toContain('Guest side chat')
    expect(html).toContain('Historical guest chat')
    expect(html).toContain('Historical guest transcript')
    expect(html).toContain('Guest participant (cursor)')
    expect(html).toContain('Guest participant (codex)')
    expect(html).toContain('Gemini historical guest transcript')
  })

  it('labels run-result seeded side chats explicitly', () => {
    const parent = makeChat()
    const runSeededSideChat = makeChat({
      appChatId: 'run-seeded-side-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      provider: 'claude',
      title: 'Run follow-up',
      sideChatContext: {
        createdAt: 2,
        lifecycleState: 'active',
        originRunId: 'run-1',
        mode: 'singleProvider',
        transcriptVisibility: 'snapshot'
      }
    })

    const html = renderToStaticMarkup(
      <LinkedChatsStrip
        currentChat={parent}
        chats={[parent, runSeededSideChat]}
        runningChatIds={[]}
        onOpenBeside={() => {}}
      />
    )

    expect(html).toContain('Run follow-up')
    expect(html).toContain('Seeded from run result')
  })

  it('labels copied parent snapshots separately from run-result seeds', () => {
    const parent = makeChat()
    const snapshotSeededSideChat = makeChat({
      appChatId: 'snapshot-side-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      provider: 'claude',
      title: 'Snapshot sidecar',
      sideChatContext: {
        createdAt: 2,
        lifecycleState: 'active',
        mode: 'singleProvider',
        transcriptVisibility: 'snapshot'
      }
    })

    const html = renderToStaticMarkup(
      <LinkedChatsStrip
        currentChat={parent}
        chats={[parent, snapshotSeededSideChat]}
        runningChatIds={[]}
        onOpenBeside={() => {}}
      />
    )

    expect(html).toContain('Snapshot sidecar')
    expect(html).toContain('Copied parent snapshot')
    expect(html).not.toContain('Seeded from run result')
  })

  it('renders nothing without linked children', () => {
    const parent = makeChat()
    const html = renderToStaticMarkup(
      <LinkedChatsStrip
        currentChat={parent}
        chats={[parent]}
        runningChatIds={[]}
        onOpenBeside={() => {}}
      />
    )

    expect(html).toBe('')
  })
})
