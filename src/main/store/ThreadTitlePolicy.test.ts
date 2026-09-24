import { describe, expect, it } from 'vitest'
import { threadTitleSourceFingerprint } from '../../shared/threadTitles'
import type { ChatMessage, ChatRecord } from './types'
import { applyLocalAiThreadTitle, applyThreadTitlePolicy } from './ThreadTitlePolicy'

function message(content = 'Repair resumed thread naming'): ChatMessage {
  return {
    id: 'user-1',
    role: 'user',
    content,
    timestamp: '2026-08-30T00:00:00.000Z'
  }
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'New Chat',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('applyThreadTitlePolicy', () => {
  it('titles a resumed placeholder once a durable human prompt exists', () => {
    const next = applyThreadTitlePolicy(chat({ messages: [message()] }), chat())
    expect(next).toMatchObject({
      title: 'Repair resumed thread naming',
      threadTitle: { source: 'prompt-fallback', sourceMessageId: 'user-1' }
    })
  })

  it('classifies legacy first-prompt titles as automatic', () => {
    const prompt = message('Explain why resumed chats keep New Chat forever')
    const next = applyThreadTitlePolicy(chat({ title: prompt.content, messages: [prompt] }), chat())
    expect(next.threadTitle).toMatchObject({
      source: 'prompt-fallback',
      sourceMessageId: 'user-1',
      sourceFingerprint: expect.stringMatching(/^title-source-v1:/)
    })
  })

  it('never overwrites or downgrades an explicit title', () => {
    const previous = chat({ title: 'My title', threadTitle: { source: 'user' } })
    const next = applyThreadTitlePolicy({ ...previous, messages: [message()] }, previous)
    expect(next.title).toBe('My title')
    expect(next.threadTitle).toEqual({ source: 'user' })
  })

  it('treats an unrelated legacy non-placeholder title as explicit', () => {
    const next = applyThreadTitlePolicy(
      chat({ title: 'Hand picked title', messages: [message()] }),
      chat()
    )
    expect(next.threadTitle).toEqual({ source: 'user' })
  })

  it('upgrades a pre-send rename instead of carrying stale placeholder provenance', () => {
    const previous = chat({ threadTitle: { source: 'placeholder' } })
    const next = applyThreadTitlePolicy({ ...previous, title: 'My pre-send title' }, previous)
    expect(next.threadTitle).toEqual({ source: 'user' })
  })

  it('restores an explicit title against a stale first-send automatic snapshot', () => {
    const previous = chat({ title: 'My title', threadTitle: { source: 'user' } })
    const next = applyThreadTitlePolicy(
      {
        ...previous,
        title: 'Repair resumed thread naming',
        messages: [message()],
        threadTitle: { source: 'prompt-fallback', sourceMessageId: 'user-1' }
      },
      previous
    )
    expect(next.title).toBe('My title')
    expect(next.threadTitle).toEqual({ source: 'user' })
  })

  it('treats a text change carrying unchanged AI provenance as an explicit rename', () => {
    const previous = chat({
      title: 'Automatic Thread Naming Result',
      threadTitle: {
        source: 'local-ai',
        sourceMessageId: 'user-1',
        sourceFingerprint: 'title-source-v1:1234abcd',
        evidenceFingerprint: `sha256:${'a'.repeat(64)}`
      },
      messages: [message()]
    })
    const next = applyThreadTitlePolicy({ ...previous, title: 'Remote manual rename' }, previous)
    expect(next.title).toBe('Remote manual rename')
    expect(next.threadTitle).toEqual({ source: 'user' })
  })
})

describe('applyLocalAiThreadTitle', () => {
  const eligible = chat({
    title: 'Repair resumed thread naming',
    threadTitle: {
      source: 'prompt-fallback',
      sourceMessageId: 'user-1',
      sourceFingerprint: threadTitleSourceFingerprint('user-1', message().content)
    },
    messages: [message()]
  })

  it('applies a matching three-to-seven-word result', () => {
    expect(
      applyLocalAiThreadTitle(eligible, {
        title: 'Resilient Thread Naming Lifecycle',
        sourceMessageId: 'user-1',
        evidenceFingerprint: `sha256:${'a'.repeat(64)}`,
        sourceFingerprint: eligible.threadTitle!.sourceFingerprint!,
        expectedTitle: eligible.title
      })
    ).toMatchObject({
      title: 'Resilient Thread Naming Lifecycle',
      threadTitle: { source: 'local-ai', evidenceFingerprint: `sha256:${'a'.repeat(64)}` }
    })
  })

  it('rejects a stale source, changed title, or explicit rename', () => {
    const base = {
      title: 'Resilient Thread Naming Lifecycle',
      sourceMessageId: 'user-1',
      sourceFingerprint: eligible.threadTitle!.sourceFingerprint!,
      evidenceFingerprint: `sha256:${'a'.repeat(64)}`,
      expectedTitle: eligible.title
    }
    expect(applyLocalAiThreadTitle(eligible, { ...base, sourceMessageId: 'other' })).toBeNull()
    expect(applyLocalAiThreadTitle({ ...eligible, title: 'Changed' }, base)).toBeNull()
    expect(
      applyLocalAiThreadTitle({ ...eligible, threadTitle: { source: 'user' } }, base)
    ).toBeNull()
    expect(
      applyLocalAiThreadTitle(
        { ...eligible, messages: [message('Edited with the same message id')] },
        base
      )
    ).toBeNull()
  })
})
