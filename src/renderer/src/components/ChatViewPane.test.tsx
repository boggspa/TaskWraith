import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import {
  ChatViewPane,
  chatViewPaneCanOpenWorkspacePopout,
  chatViewPaneChromeActionEqual,
  chatViewPaneChromeActionsEqual,
  chatViewPanePropsEqual,
  type ChatViewPaneProps
} from './ChatViewPane'
import { createMultiviewPaneRefs } from '../hooks/useMultiviewState'
import { WorkspaceGitSnapshotStore } from '../lib/workspaceGitSnapshotStore'

const paneSource = readFileSync(new URL('./ChatViewPane.tsx', import.meta.url), 'utf8')

// The pane composer is now the SAME first-class <Composer> the focused main
// pane renders (built by App from `composerCtx` with per-pane overrides). It
// needs ~290 props, so rather than recreate that surface here we stub the
// module and assert ChatViewPane DELEGATES to it: the sentinel renders iff a
// `composerProps` context is supplied. Composer's own markup is covered by its
// dedicated tests.
vi.mock('./Composer', () => ({
  Composer: (props: {
    prompt?: string
    composerAreaRef?: { current: HTMLDivElement | null }
    showWelcomeNotifications?: boolean
    primaryGitSnapshot?: { branch?: string }
    workspaceDiffStats?: { filesChanged: number; additions: number; deletions: number }
  }) => (
    <div
      data-testid="pane-composer-stub"
      data-has-local-composer-ref={String(Boolean(props.composerAreaRef))}
      data-show-welcome-notifications={String(props.showWelcomeNotifications)}
      data-git-branch={props.primaryGitSnapshot?.branch || ''}
      data-git-changed={String(props.workspaceDiffStats?.filesChanged ?? 0)}
    >{`pane-composer:${props.prompt ?? ''}`}</div>
  )
}))

// Minimal stand-in for the (huge) ComposerProps object. ChatViewPane only
// forwards it untouched to <Composer>, so a cast is faithful here.
const stubComposerProps = (prompt = ''): ChatViewPaneProps['composerProps'] =>
  ({ prompt }) as unknown as ChatViewPaneProps['composerProps']

const sharedRefs = createMultiviewPaneRefs()
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

  it('re-renders when runningChatIds content changes for the sub-thread ticker', () => {
    expect(
      chatViewPanePropsEqual(
        makeProps({ runningChatIds: [] }),
        makeProps({ runningChatIds: ['child-1'] })
      )
    ).toBe(false)
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

  it('re-renders when its path-scoped Git subscription changes ownership', () => {
    const store = new WorkspaceGitSnapshotStore()
    expect(
      chatViewPanePropsEqual(
        makeProps({ gitSnapshotStore: store, gitSnapshotPath: '/one' }),
        makeProps({ gitSnapshotStore: store, gitSnapshotPath: '/two' })
      )
    ).toBe(false)
  })

  it('ignores rebuilt chrome callbacks and icons when the visible action model is unchanged', () => {
    const first = [
      {
        id: 'preview',
        title: 'Preview',
        icon: <span>first icon</span>,
        active: false,
        disabled: false,
        onClick: vi.fn()
      }
    ]
    const second = [
      {
        id: 'preview',
        title: 'Preview',
        icon: <span>second icon</span>,
        active: false,
        disabled: false,
        onClick: vi.fn()
      }
    ]

    expect(chatViewPaneChromeActionsEqual(first, second)).toBe(true)
    const firstLeft = {
      id: 'workspace-sidebar',
      title: 'Hide workspace sidebar',
      icon: <span>first sidebar icon</span>,
      onClick: vi.fn()
    }
    const secondLeft = {
      ...firstLeft,
      icon: <span>second sidebar icon</span>,
      onClick: vi.fn()
    }
    expect(chatViewPaneChromeActionEqual(firstLeft, secondLeft)).toBe(true)
    expect(
      chatViewPanePropsEqual(
        makeProps({ topLeftChromeAction: firstLeft, topRightChromeActions: first }),
        makeProps({ topLeftChromeAction: secondLeft, topRightChromeActions: second })
      )
    ).toBe(true)
  })

  it('re-renders when a pane chrome action changes visible state', () => {
    const first = [{ id: 'preview', title: 'Preview', icon: <span />, active: false }]
    const second = [{ id: 'preview', title: 'Preview', icon: <span />, active: true }]

    expect(chatViewPaneChromeActionsEqual(first, second)).toBe(false)
  })

  it('enables workspace popouts only when every shared menu target is actionable', () => {
    const actions = ['popout-workbench', 'popout-diff-studio', 'popout-file-editor'].map((id) => ({
      id,
      title: id,
      icon: <span />,
      onClick: vi.fn()
    }))

    expect(chatViewPaneCanOpenWorkspacePopout(actions)).toBe(true)
    expect(
      chatViewPaneCanOpenWorkspacePopout(
        actions.map((action) =>
          action.id === 'popout-diff-studio' ? { ...action, disabled: true } : action
        )
      )
    ).toBe(false)
  })
})

describe('ChatViewPane welcome viewer', () => {
  it('renders current pane chrome and hosts the shared welcome composer without a duplicate notice', () => {
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
    // A welcome pane has no clone-era spacer/transcript. Shared Composer owns
    // the welcome layout, while app-global notices stay with the focused pane.
    expect(html).toContain('multiview-pane-corner-controls')
    expect(html).toContain('chat-corner-thread-context')
    expect(html).toContain('sidebar-provider-icon')
    expect(html).toContain('chat-corner-workspace-name')
    expect(html).toContain('>AGBench</span>')
    expect(html).not.toContain('multiview-pane-welcome-spacer')
    expect(html).not.toContain('transcript-scroll')
    // The welcome hero / starters / composer now belong to the shared
    // <Composer> (stubbed here) — the pane simply hosts it.
    expect(html).toContain('data-testid="pane-composer-stub"')
    expect(html).toContain('data-show-welcome-notifications="false"')
  })

  it('marks a resting General Chat with the same scope class as the focused pane', () => {
    const html = renderToStaticMarkup(
      <ChatViewPane
        {...makeProps({
          chat: {
            appChatId: 'global-chat',
            scope: 'global',
            title: 'General Chat'
          } as unknown as ChatViewPaneProps['chat'],
          welcomeIsGlobalChat: true,
          composerProps: stubComposerProps()
        })}
      />
    )

    expect(html).toContain('chat-scope-global')
  })
})

describe('ChatViewPane shared composer', () => {
  it('does not promote a pane when the user interacts with its transcript or composer', () => {
    expect(paneSource).not.toContain('onMouseDownCapture')
    expect(paneSource).toContain('onClick: props.onFocusPane')
  })

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
    expect(html).toContain('data-has-local-composer-ref="true"')
    expect(html).toContain('pane-composer:Pane prompt') // pane context forwarded verbatim
  })

  it('projects only its path-scoped Git snapshot into the shared composer', () => {
    const store = new WorkspaceGitSnapshotStore()
    store.set('/repo', {
      requestedPath: '/repo',
      repoRoot: '/repo',
      branch: 'pane-branch',
      detached: false,
      ahead: 0,
      behind: 0,
      files: [],
      counts: { changed: 3, staged: 0, unstaged: 3, untracked: 0 },
      clean: false,
      mergeState: null,
      conflicts: 0,
      lineStats: { additions: 8, deletions: 2 }
    } as GitRepositorySnapshot)

    const html = renderToStaticMarkup(
      <ChatViewPane
        {...makeProps({
          chat: { appChatId: 'chat-1' } as unknown as ChatViewPaneProps['chat'],
          composerProps: stubComposerProps(),
          gitSnapshotStore: store,
          gitSnapshotPath: '/repo'
        })}
      />
    )

    expect(html).toContain('data-git-branch="pane-branch"')
    expect(html).toContain('data-git-changed="3"')
  })

  it('mounts SubThreadStatusTicker above the transcript for a parent with a running child', () => {
    const parent = {
      appChatId: 'parent-1',
      provider: 'claude',
      title: 'Parent'
    } as unknown as ChatViewPaneProps['chat']
    const child = {
      appChatId: 'child-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'subThread',
      provider: 'codex',
      title: 'Child'
    } as unknown as ChatViewPaneProps['chats'][number]

    const html = renderToStaticMarkup(
      <ChatViewPane
        {...makeProps({
          chat: parent,
          chats: [parent as ChatViewPaneProps['chats'][number], child],
          runningChatIds: ['child-1'],
          composerProps: stubComposerProps()
        })}
      />
    )

    expect(html).toContain('subthread-status-ticker')
    expect(html).toContain('sub-thread active')
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

describe('ChatViewPane chrome actions', () => {
  it('keeps focused-only legacy controls inside the pane header', () => {
    const html = renderToStaticMarkup(
      <ChatViewPane
        {...makeProps({
          chat: { appChatId: 'chat-1' } as unknown as ChatViewPaneProps['chat'],
          topLeftChromeExtra: <button type="button">People</button>
        })}
      />
    )

    expect(html).toContain('>People</button>')
  })

  it('renders the same six workspace actions as the focused pane with pane-scoped ids', () => {
    const html = renderToStaticMarkup(
      <ChatViewPane
        {...makeProps({
          chat: { appChatId: 'chat-1' } as unknown as ChatViewPaneProps['chat'],
          currentWorkspacePath: '/repo',
          topLeftChromeAction: {
            id: 'workspace-sidebar',
            title: 'Hide workspace sidebar',
            ariaLabel: 'Toggle workspace sidebar',
            icon: <span>sidebar-toggle</span>,
            onClick: vi.fn()
          },
          topRightChromeActions: [
            {
              id: 'preview',
              title: 'Choose preview target',
              icon: <span>preview</span>,
              active: true,
              menuOpen: true,
              menu: (
                <div className="side-chat-layout-menu pane-preview-menu" role="menu">
                  <button type="button" role="menuitem">
                    Preview :5173
                  </button>
                </div>
              ),
              onClick: vi.fn()
            },
            {
              id: 'home',
              title: 'Hide sidebar home',
              ariaLabel: 'Toggle sidebar home',
              icon: <span>home</span>,
              active: true,
              onClick: vi.fn()
            }
          ]
        })}
      />
    )

    const actionIds = Array.from(
      html.matchAll(/data-main-pane-action="([^"]+)"/g),
      (match) => match[1]
    )
    expect(actionIds).toEqual(['fx', 'info', 'workspace-stats', 'popout', 'run', 'home'])
    expect(html).toContain('title="Hide workspace sidebar"')
    expect(html).toContain('sidebar-toggle')
    expect(html).toContain('id="multiview-pane-1-fx-trigger"')
    expect(html).toContain('id="multiview-pane-1-info-trigger"')
    expect(html).toContain('id="multiview-pane-1-workspace-stats-trigger"')
    expect(html).toContain('data-preview-menu-root="true"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('pane-preview-menu')
    expect(html).toContain('Preview :5173')
    expect(html).toContain('title="Hide sidebar home"')
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

describe('ChatViewPane per-pane sky + living-workspace FX', () => {
  const fxProps = (over: Partial<ChatViewPaneProps> = {}): ChatViewPaneProps =>
    makeProps({
      chat: { appChatId: 'chat-1' } as unknown as ChatViewPaneProps['chat'],
      composerProps: stubComposerProps(),
      weather: null,
      intensity: 'cinematic',
      ...over
    })

  it('renders the inline sky layer when showSky is true', () => {
    const html = renderToStaticMarkup(<ChatViewPane {...fxProps({ showSky: true })} />)
    expect(html).toContain('sky-visual-fx')
  })

  it('renders the inline living-workspace layer when showLivingWorkspace is true', () => {
    const html = renderToStaticMarkup(<ChatViewPane {...fxProps({ showLivingWorkspace: true })} />)
    expect(html).toContain('living-workspace-layer')
  })

  it('renders neither sky nor living-workspace when both flags are off', () => {
    const html = renderToStaticMarkup(<ChatViewPane {...fxProps()} />)
    expect(html).not.toContain('sky-visual-fx')
    expect(html).not.toContain('living-workspace-layer')
  })

  it('re-renders (comparator) when a pane FX flag, weather, or intensity changes', () => {
    expect(chatViewPanePropsEqual(fxProps(), fxProps({ showSky: true }))).toBe(false)
    expect(chatViewPanePropsEqual(fxProps(), fxProps({ showLivingWorkspace: true }))).toBe(false)
    const weather = { kind: 'rain' } as unknown as ChatViewPaneProps['weather']
    expect(chatViewPanePropsEqual(fxProps(), fxProps({ weather }))).toBe(false)
    expect(chatViewPanePropsEqual(fxProps(), fxProps({ intensity: 'epic' }))).toBe(false)
  })
})
