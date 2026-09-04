import { act, useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composerDraftState, useComposerDraft } from '../hooks/useComposerDraft'
import { ChatTranscriptStore, type ChatTranscriptPayload } from './chatTranscriptStore'
import {
  bindChatTranscriptStore,
  getChatTranscriptSnapshot,
  resetChatTranscriptStoreBindingForTests,
  useChatTranscript
} from './useChatTranscript'

let root: Root | null = null
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

// The observers render no host elements. This is enough DOM for a real React
// root and scheduler without adding a DOM emulator to the renderer suite.
function installRendererRoot(): Root {
  for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  class MinimalElement extends EventTarget {
    readonly nodeType = 1
  }
  class MinimalIFrame extends MinimalElement {}
  const documentTarget = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
    body: null,
    documentElement: {}
  })
  const windowTarget = Object.assign(new EventTarget(), {
    document: documentTarget,
    HTMLElement: MinimalElement,
    HTMLIFrameElement: MinimalIFrame
  })
  Object.assign(documentTarget, { defaultView: windowTarget })
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true }
  })
  const container = Object.assign(new MinimalElement(), {
    ownerDocument: documentTarget,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    firstChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as Element
  root = createRoot(container)
  return root
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  composerDraftState.replaceAll({})
  resetChatTranscriptStoreBindingForTests()
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as Record<string, unknown>)[key]
  }
  savedGlobals.clear()
})

function publish(store: ChatTranscriptStore, chatId: string, content: string): void {
  store.set(chatId, {
    messages: [{ id: `${chatId}-reply`, role: 'assistant', content, timestamp: '1' }],
    runs: []
  })
}

describe('transcript presentation scheduling', () => {
  it('commits composer input before a burst of transcript updates, keeping the store current', () => {
    const store = new ChatTranscriptStore()
    bindChatTranscriptStore(store)
    publish(store, 'chat-a', 'initial')
    const initial = getChatTranscriptSnapshot('chat-a')
    const transcriptCommits: ChatTranscriptPayload[] = []
    let committedDraft = ''
    function Transcript() {
      const transcript = useChatTranscript('chat-a')
      useLayoutEffect(() => {
        transcriptCommits.push(transcript)
      }, [transcript])
      return null
    }
    function Composer() {
      const draft = useComposerDraft('chat-a')
      useLayoutEffect(() => {
        committedDraft = draft
      }, [draft])
      return null
    }
    const mountedRoot = installRendererRoot()
    act(() =>
      mountedRoot.render(
        <>
          <Transcript />
          <Composer />
        </>
      )
    )
    expect(transcriptCommits).toEqual([initial])

    act(() => {
      flushSync(() => {
        for (let index = 0; index < 30; index += 1) {
          publish(store, 'chat-a', `stream ${index}`)
        }
        composerDraftState.setDraft('chat-a', 'keep typing')
      })
      // Same urgent commit as a native input event. A synchronous external
      // transcript subscription pulls the expensive transcript into it too.
      expect(committedDraft).toBe('keep typing')
      expect(transcriptCommits).toEqual([initial])
      expect(getChatTranscriptSnapshot('chat-a').messages[0].content).toBe('stream 29')
    })
    expect(transcriptCommits).toEqual([initial, getChatTranscriptSnapshot('chat-a')])
  })

  it('switches chats immediately without committing the previous chat from a pending update', () => {
    const store = new ChatTranscriptStore()
    bindChatTranscriptStore(store)
    publish(store, 'chat-a', 'a')
    publish(store, 'chat-b', 'b')
    const commits: string[] = []
    function Transcript({ chatId }: { chatId: string | null }) {
      const transcript = useChatTranscript(chatId)
      useLayoutEffect(() => {
        commits.push(`${chatId}:${transcript.messages[0]?.content ?? 'empty'}`)
      }, [chatId, transcript])
      return null
    }
    const mountedRoot = installRendererRoot()
    act(() => mountedRoot.render(<Transcript chatId="chat-a" />))
    act(() => {
      publish(store, 'chat-a', 'a pending')
      flushSync(() => mountedRoot.render(<Transcript chatId="chat-b" />))
      expect(commits).toEqual(['chat-a:a', 'chat-b:b'])
      publish(store, 'chat-a', 'a after unsubscribe')
      publish(store, 'chat-b', 'b latest')
    })
    expect(commits).toEqual(['chat-a:a', 'chat-b:b', 'chat-b:b latest'])
    act(() => {
      flushSync(() => mountedRoot.render(<Transcript chatId={null} />))
      expect(commits.at(-1)).toBe('null:empty')
    })
  })

  it('catches a store write between render and subscription', () => {
    const store = new ChatTranscriptStore()
    bindChatTranscriptStore(store)
    publish(store, 'chat-a', 'before mount')
    let committed: ChatTranscriptPayload | undefined
    function EarlierSibling() {
      useLayoutEffect(() => publish(store, 'chat-a', 'during commit'), [])
      return null
    }
    function Transcript() {
      const transcript = useChatTranscript('chat-a')
      useLayoutEffect(() => {
        committed = transcript
      }, [transcript])
      return null
    }
    const mountedRoot = installRendererRoot()
    act(() =>
      mountedRoot.render(
        <>
          <EarlierSibling />
          <Transcript />
        </>
      )
    )
    expect(committed).toBe(getChatTranscriptSnapshot('chat-a'))
    expect(committed?.messages[0].content).toBe('during commit')
  })

  it('does not revive a queued snapshot when navigating away and back before it renders', () => {
    const store = new ChatTranscriptStore()
    bindChatTranscriptStore(store)
    publish(store, 'chat-a', 'initial')
    const commits: string[] = []
    function Transcript({ chatId }: { chatId: string }) {
      const transcript = useChatTranscript(chatId)
      useLayoutEffect(() => {
        commits.push(`${chatId}:${transcript.messages[0]?.content ?? 'empty'}`)
      }, [chatId, transcript])
      return null
    }
    const mountedRoot = installRendererRoot()
    act(() => mountedRoot.render(<Transcript chatId="chat-a" />))
    act(() => {
      publish(store, 'chat-a', 'queued')
      flushSync(() => mountedRoot.render(<Transcript chatId="chat-b" />))
      publish(store, 'chat-a', 'latest while away')
      flushSync(() => mountedRoot.render(<Transcript chatId="chat-a" />))
    })
    expect(commits).toEqual(['chat-a:initial', 'chat-b:empty', 'chat-a:latest while away'])
  })

  it('does not rerender for another chat and releases its subscription on unmount', () => {
    const store = new ChatTranscriptStore()
    bindChatTranscriptStore(store)
    const subscribe = store.subscribe.bind(store)
    const released = vi.fn()
    vi.spyOn(store, 'subscribe').mockImplementation((chatId, listener) => {
      const unsubscribe = subscribe(chatId, listener)
      return () => {
        unsubscribe()
        released()
      }
    })
    let renders = 0
    function Transcript() {
      useChatTranscript('chat-a')
      renders += 1
      return null
    }
    const mountedRoot = installRendererRoot()
    act(() => mountedRoot.render(<Transcript />))
    const initialRenders = renders
    act(() => publish(store, 'chat-b', 'other chat'))
    expect(renders).toBe(initialRenders)
    act(() => mountedRoot.unmount())
    root = null
    expect(released).toHaveBeenCalledTimes(1)
    act(() => publish(store, 'chat-a', 'after unmount'))
    expect(renders).toBe(initialRenders)
  })
})
