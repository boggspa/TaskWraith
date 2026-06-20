import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatViewPane, chatViewPanePropsEqual, type ChatViewPaneProps } from './ChatViewPane'

// The pane composer is now the SAME first-class <Composer> the focused main
// pane renders (built by App from `composerCtx` with per-pane overrides). It
// needs ~290 props, so rather than recreate that surface here we stub the
// module and assert ChatViewPane DELEGATES to it: the sentinel renders iff a
// `composerProps` context is supplied. Composer's own markup is covered by its
// dedicated tests.
vi.mock('./Composer', () => ({
  Composer: (props: { prompt?: string }) => (
    <div data-testid="pane-composer-stub">{`pane-composer:${props.prompt ?? ''}`}</div>
  )
}))

// Minimal stand-in for the (huge) ComposerProps object. ChatViewPane only
// forwards it untouched to <Composer>, so a cast is faithful here.
const stubComposerProps = (prompt = ''): ChatViewPaneProps['composerProps'] =>
  ({ prompt }) as unknown as ChatViewPaneProps['composerProps']

const ref = () => ({ current: null }) as ChatViewPaneProps['refs']['scrollRef']

const sharedRefs = { scrollRef: ref(), contentRef: ref(), endRef: ref() }
const sharedCopy = vi.fn()
const sharedOpenSub = vi.fn()
const sharedCopyMsg = vi.fn()
const sharedPreview = vi.fn()
const sharedFocus = vi.fn()
// Shared empties so two makeProps() calls are reference-identical where the
// comparator actually looks (messages, pendingAgentQuestions).
const EMPTY_MESSAGES = [] as ChatViewPaneProps['messages']
const EMPTY_QUESTIONS = [] as ChatViewPaneProps['pendingAgentQuestions']
const EMPTY_CHATS = [] as ChatViewPaneProps['chats']
const EMPTY_RUNNING = [] as ChatViewPaneProps['runningChatIds']

const makeProps = (over: Partial<ChatViewPaneProps> = {}): ChatViewPaneProps => ({
  refs: sharedRefs,
  chat: null,
  paneIndex: 1,
  messages: EMPTY_MESSAGES,
  provider: 'codex',
  providerLabel: 'Codex',
  isWelcomeChat: false,
  isThinking: false,
  runCompleteNotice: null,
  pendingAgentQuestions: EMPTY_QUESTIONS,
  chats: EMPTY_CHATS,
  runningChatIds: EMPTY_RUNNING,
  compactDensity: false,
  copiedId: null,
  copy: sharedCopy,
  onOpenSubThread: sharedOpenSub,
  onCopyMessage: sharedCopyMsg,
  onPreviewImage: sharedPreview,
  interfaceStyle: 'cursor',
  providerClass: 'codex',
  welcomeWorkspaceName: 'AGBench',
  welcomeIsGlobalChat: false,
  onFocusPane: sharedFocus,
  ...over
})

describe('chatViewPanePropsEqual', () => {
  it('treats identical props as equal (skip render)', () => {
    expect(chatViewPanePropsEqual(makeProps(), makeProps())).toBe(true)
  })

  it('skips re-render when only the high-churn shared arrays change identity', () => {
    // The whole point: a token in another pane re-creates chats/runningChatIds
    // every frame, but this pane's own messages are unchanged -> no reconcile.
    const a = makeProps({ chats: [], runningChatIds: [] })
    const b = makeProps({ chats: [], runningChatIds: [] }) // fresh arrays, same content
    expect(a.chats).not.toBe(b.chats)
    expect(chatViewPanePropsEqual(a, b)).toBe(true)
  })

  it('re-renders when this pane’s own messages change', () => {
    const messages = [{ id: 'm1' }] as unknown as ChatViewPaneProps['messages']
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ messages }))).toBe(false)
  })

  it('re-renders on run-state, copy-feedback, and appearance changes', () => {
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ isThinking: true }))).toBe(false)
    expect(
      chatViewPanePropsEqual(
        makeProps(),
        makeProps({ runCompleteNotice: { timestamp: 't', exitCode: 0 } })
      )
    ).toBe(false)
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ copiedId: 'm1' }))).toBe(false)
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ interfaceStyle: 'codex' }))).toBe(false)
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ providerClass: 'claude' }))).toBe(false)
  })

  it('re-renders when the chat record identity changes', () => {
    const chat = { appChatId: 'c2' } as unknown as ChatViewPaneProps['chat']
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ chat }))).toBe(false)
  })

  it('re-renders when a viewer is reused for a different pane index', () => {
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ paneIndex: 2 }))).toBe(false)
  })

  it('re-renders when welcome context changes', () => {
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ welcomeWorkspaceName: 'Other' }))).toBe(
      false
    )
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ welcomeIsGlobalChat: true }))).toBe(
      false
    )
  })

  it('re-renders when the pane composer context identity changes', () => {
    // The writable composer (prompt/run/model/permission/…) now lives entirely
    // in the shared <Composer>, driven by `composerProps`. App rebuilds that
    // context object per render with this pane's values, so a new identity must
    // reconcile the pane — this replaces the old per-control comparator checks.
    expect(
      chatViewPanePropsEqual(makeProps(), makeProps({ composerProps: stubComposerProps('x') }))
    ).toBe(false)
  })
})

describe('ChatViewPane welcome viewer', () => {
  it('renders the pane chrome + welcome spacer (not an empty transcript) and hosts the shared composer', () => {
    const html = renderToStaticMarkup(
      <ChatViewPane
        {...makeProps({
          chat: {
            appChatId: 'chat-1',
            scope: 'workspace',
            title: 'New Chat',
            workspacePath: '/tmp/AGBench'
          } as unknown as ChatViewPaneProps['chat'],
          isWelcomeChat: true,
          messages: [],
          provider: 'codex',
          providerLabel: 'Codex',
          providerClass: 'codex',
          welcomeWorkspaceName: 'AGBench',
          composerProps: stubComposerProps()
        })}
      />
    )
    // ChatViewPane still owns the pane chrome + the welcome spacer (the
    // transcript is replaced, not rendered, on a welcome chat).
    expect(html).toContain('multiview-pane-corner-controls')
    expect(html).toContain('multiview-pane-welcome-spacer')
    expect(html).not.toContain('transcript-scroll')
    // The welcome hero / starters / composer now belong to the shared
    // <Composer> (stubbed here) — the pane simply hosts it.
    expect(html).toContain('data-testid="pane-composer-stub"')
  })
})

describe('ChatViewPane shared composer', () => {
  it('renders the shared <Composer> (forwarding the pane context) when composerProps is supplied', () => {
    const html = renderToStaticMarkup(
      <ChatViewPane
        {...makeProps({
          chat: { appChatId: 'chat-1' } as unknown as ChatViewPaneProps['chat'],
          composerProps: stubComposerProps('Pane prompt')
        })}
      />
    )
    expect(html).toContain('data-testid="pane-composer-stub"')
    expect(html).toContain('pane-composer:Pane prompt') // pane context forwarded verbatim
  })

  it('renders no composer when composerProps is absent (read-only fallback)', () => {
    const html = renderToStaticMarkup(
      <ChatViewPane
        {...makeProps({ chat: { appChatId: 'chat-1' } as unknown as ChatViewPaneProps['chat'] })}
      />
    )
    expect(html).not.toContain('data-testid="pane-composer-stub"')
  })
})

describe('ChatViewPane per-pane agent aura', () => {
  const auraProps = (over: Partial<ChatViewPaneProps> = {}): ChatViewPaneProps =>
    makeProps({
      chat: { appChatId: 'chat-1' } as unknown as ChatViewPaneProps['chat'],
      composerProps: stubComposerProps(),
      showAura: true,
      auraProvider: 'codex',
      auraStatus: 'running',
      auraIntensity: 'cinematic',
      ...over
    })

  it('renders the AgentAuraLayer keyed to the pane provider + status when FX is on', () => {
    const html = renderToStaticMarkup(<ChatViewPane {...auraProps()} />)
    expect(html).toContain('agent-aura-layer')
    expect(html).toContain('fx-provider-codex')
    expect(html).toContain('fx-status-running')
    expect(html).toContain('fx-intensity-cinematic')
  })

  it('keys the aura to the ensemble palette for ensemble panes', () => {
    const html = renderToStaticMarkup(
      <ChatViewPane {...auraProps({ auraProvider: 'ensemble', auraStatus: 'idle' })} />
    )
    expect(html).toContain('fx-provider-ensemble')
  })

  it('renders no aura layer when FX is globally off', () => {
    const html = renderToStaticMarkup(<ChatViewPane {...auraProps({ showAura: false })} />)
    expect(html).not.toContain('agent-aura-layer')
  })

  it('re-renders (comparator) when the pane aura status/provider/intensity changes', () => {
    expect(chatViewPanePropsEqual(auraProps(), auraProps({ auraStatus: 'approval' }))).toBe(false)
    expect(chatViewPanePropsEqual(auraProps(), auraProps({ auraProvider: 'claude' }))).toBe(false)
    expect(chatViewPanePropsEqual(auraProps(), auraProps({ auraIntensity: 'epic' }))).toBe(false)
    expect(chatViewPanePropsEqual(auraProps(), auraProps({ showAura: false }))).toBe(false)
  })
})
