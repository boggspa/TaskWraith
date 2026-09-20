import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatMessage, ChatRecord } from '../../src/main/store/types'
import { buildTranscriptPage } from '../../src/shared/transcriptPage'
import {
  TranscriptPanel,
  type TranscriptPanelProps
} from '../../src/renderer/src/components/TranscriptPanel'
import { ChatTranscriptStore } from '../../src/renderer/src/lib/chatTranscriptStore'
import { bindChatTranscriptStore } from '../../src/renderer/src/lib/useChatTranscript'

const report = (value: unknown) => {
  ;(window as unknown as { reportProbe: (result: unknown) => void }).reportProbe(value)
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const settle = async () => {
  for (let index = 0; index < 12; index++) await frame()
}
const noop = () => undefined
const store = new ChatTranscriptStore()
bindChatTranscriptStore(store)
const style = document.createElement('style')
style.textContent = `
  :root { --space-lg: 16px; --space-md: 12px; --space-sm: 6px;
    --composer-content-max-width: 850px; --chat-side-gutter: 24px; }
  body { margin: 0; background: #181818; color: white; font: 14px system-ui; }
  #root { display: flex; height: 960px; width: 1000px; }
  .transcript-scroll { min-height: 0; flex: 1; }
`
document.head.append(style)
let pageReads = 0
let currentChat: ChatRecord
window.api = {
  getChatTranscriptPage: async (request) => {
    pageReads++
    if (pageReads > 40) throw new Error('Repeated automatic page reads')
    return buildTranscriptPage(currentChat, request)
  }
} as typeof window.api

function chatFor(mode: string): ChatRecord {
  const messages: ChatMessage[] = Array.from({ length: 13_000 }, (_, index) => ({
    id: `${mode}-tool-${index}`,
    role: 'tool',
    content: '',
    timestamp: '2026-09-20T12:00:00.000Z',
    runId: 'run',
    toolActivities: [
      {
        id: `activity-${index}`,
        toolName: 'read_file',
        displayName: 'Read fixture',
        category: 'read',
        status: 'success'
      }
    ]
  }))
  return {
    appChatId: `paging-${mode}`,
    provider: 'codex',
    title: 'Grouped paging regression',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages,
    runs: []
  } as ChatRecord
}

function Fixture({ chat, following }: { chat: ChatRecord; following: { current: boolean } }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const props: TranscriptPanelProps = {
    scrollRef,
    contentRef,
    endRef,
    autoFollowRef: following,
    messages: chat.messages,
    currentChat: chat,
    currentProvider: 'codex',
    currentProviderLabel: 'Codex',
    isWelcomeChat: false,
    isThinking: false,
    pendingPlanChoice: null,
    pendingProposedPlan: null,
    pendingAgentQuestions: [],
    contextCompactionProgress: [],
    onAgentQuestionSubmit: noop,
    onAgentQuestionDismiss: noop,
    runCompleteNotice: null,
    runCompleteDurationText: null,
    displayFileChangeSummaries: [],
    fileChangeSummaryText: '',
    fileChangeShouldShowStats: false,
    fileChangeDisplayAdds: 0,
    fileChangeDisplayDels: 0,
    chats: [chat],
    runningChatIds: [],
    onPlanChoiceSubmit: noop,
    onProposedPlanApprove: noop,
    onProposedPlanDismiss: noop,
    onProposedPlanCustom: noop,
    onOpenSubThread: noop,
    compactDensity: false,
    liveActivityViewport: true,
    onCopyMessage: noop,
    onDeleteMessage: noop,
    onPreviewImage: noop,
    copiedId: null,
    copy: noop,
    virtualize: true,
    userMessageGutterEnabled: false
  }
  return <TranscriptPanel {...props} />
}

async function exercise(mode: 'hydrated' | 'paged') {
  const chat = chatFor(mode)
  currentChat = chat
  pageReads = 0
  if (mode === 'paged') store.ingestPage(buildTranscriptPage(chat, { chatId: chat.appChatId })!)
  else store.ingest(chat)
  let publications = 0
  const unsubscribe = store.subscribe(chat.appChatId, () => publications++)
  const initialStart = store.getSnapshot(chat.appChatId).windowStart
  const root = createRoot(document.getElementById('root')!)
  const following = { current: true }
  try {
    root.render(<Fixture chat={chat} following={following} />)
    await settle()
    if (store.getSnapshot(chat.appChatId).windowStart !== initialStart) {
      throw new Error(`${mode}: opening the tail loaded older history`)
    }
    const scroller = document.querySelector<HTMLDivElement>('.transcript-scroll')!
    // A collapsed window need not have a scrollbar. Each explicit wheel
    // gesture can advance one page; store publication cannot refill itself.
    following.current = false
    for (let index = 0; index < 10 && store.getSnapshot(chat.appChatId).hasOlder; index++) {
      scroller.scrollTop = 0
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }))
      scroller.dispatchEvent(new Event('scroll'))
      await settle()
    }
    const oldest = store.getSnapshot(chat.appChatId)
    if (oldest.windowStart !== 0 || !oldest.hasNewer) {
      throw new Error(`${mode}: earlier-history browsing failed`)
    }
    const idleStart = publications
    await settle()
    if (publications !== idleStart) throw new Error(`${mode}: idle paging churn`)
    for (let index = 0; index < 10 && store.getSnapshot(chat.appChatId).hasNewer; index++) {
      scroller.scrollTop = scroller.scrollHeight
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 400 }))
      scroller.dispatchEvent(new Event('scroll'))
      await settle()
    }
    if (store.getSnapshot(chat.appChatId).hasNewer) {
      throw new Error(`${mode}: newer-history browsing failed`)
    }
    return {
      mode,
      publications,
      pageReads,
      mountedRows: scroller.querySelectorAll('[data-vrow-id]').length
    }
  } finally {
    root.unmount()
    unsubscribe()
  }
}

async function run() {
  const results = []
  for (const mode of ['hydrated', 'paged'] as const) results.push(await exercise(mode))
  report({ ok: true, results })
}
run().catch((error) => report({ ok: false, error: String(error?.stack || error) }))
