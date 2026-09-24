/**
 * Settings → TaskWraith Host card.
 *
 * No DOM here: the card is rendered with `renderToStaticMarkup`, where effects
 * never run, so every assertion on the markup is an assertion on the FIRST
 * PAINT. That is the point — the card must show the Host's facts from the
 * snapshot and inspect answer it was seeded with, before any IPC resolves.
 * Buttons are exercised by calling the pure view and invoking the handlers on
 * the returned element tree.
 */

import { act, isValidElement, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostLifecycleInspectResult,
  HostLifecycleSnapshot
} from '../../../shared/hostLifecycle'
import type { HostStatusProjection } from '../../../shared/hostProtocol'
import { MainSourceProbe } from '../../../main/mainSourceProbe.testutil'
import {
  HostLifecycleIpcClient,
  type HostLifecycleBridge,
  type HostLifecycleInspection
} from '../lib/host/hostLifecycleIpcClient'
import type { HostProjectionState, HostProjectionStore } from '../lib/host/HostProjectionStore'
import type { HostProjectedSnapshot } from '../lib/host/hostSnapshotProjection'
import * as projectionProvider from './HostProjectionProvider'
import {
  HOST_FACT_NOT_AVAILABLE,
  HostSettingsCard,
  HostSettingsCardView,
  countLiveHostRuns,
  describeHostAppLease,
  describeHostCardButtons,
  planHostCardAction,
  shortHostPayload,
  type HostSettingsCardViewProps
} from './HostSettingsCard'

const PAYLOAD = `sha256:${'ab'.repeat(32)}`
let mountedRoot: Root | null = null

function lifecycle(overrides: Partial<HostLifecycleSnapshot> = {}): HostLifecycleSnapshot {
  return {
    revision: 7,
    phase: 'running',
    desired: 'running',
    reason: 'app-start',
    changedAt: '2026-09-23T12:00:04.000Z',
    host: {
      pid: 4242,
      hostId: 'host-install-1',
      startedAt: '2026-09-23T12:00:00.000Z',
      payloadVersion: PAYLOAD
    },
    ...overrides
  }
}

function hostStatus(overrides: Partial<HostStatusProjection> = {}): HostStatusProjection {
  return {
    pid: 4242,
    startedAt: '2026-09-23T12:00:00.000Z',
    uptimeMs: 11_520_000,
    hostId: 'host-install-1',
    payloadVersion: PAYLOAD,
    profilePath: '/Users/example/Library/Application Support/TaskWraith',
    persist: false,
    lifetime: { phase: 'held', holders: 2, implicitHolders: 1, declined: 3 },
    liveWork: { runs: 0 },
    clients: [
      {
        clientClass: 'desktop',
        clientId: 'taskwraith-desktop-lease',
        connectedForMs: 60_000,
        lease: 'explicit',
        capabilities: ['bootstrap', 'health']
      },
      {
        clientClass: 'tui',
        clientId: 'tui-7f3a',
        connectedForMs: 2 * 3_600_000 + 5 * 60_000,
        lease: 'implicit',
        capabilities: ['bootstrap', 'snapshot', 'deltas']
      },
      {
        clientClass: 'ios',
        displayName: 'Studio iPhone',
        connectedForMs: 42_000,
        lease: 'declined',
        capabilities: ['bootstrap']
      }
    ],
    ...overrides
  }
}

function inspection(overrides: Partial<HostLifecycleInspection> = {}): HostLifecycleInspection {
  return {
    snapshot: lifecycle(),
    host: hostStatus(),
    lease: { mode: 'lease', held: true, reasons: ['app'] },
    ...overrides
  }
}

function silentBridge(): HostLifecycleBridge {
  return {
    hostLifecycleStatus: vi.fn(async () => ({ ok: true as const, snapshot: lifecycle() })),
    hostLifecycleSet: vi.fn(async () => ({ ok: true as const, snapshot: lifecycle() })),
    onHostLifecycleChanged: vi.fn(() => () => undefined),
    hostLifecycleInspect: vi.fn(async () => ({ ok: true as const, ...inspection() }))
  }
}

function renderCard(
  initialSnapshot: HostLifecycleSnapshot | null,
  initialInspect: HostLifecycleInspection | null,
  bridge: HostLifecycleBridge = silentBridge()
): string {
  return renderToStaticMarkup(
    <HostSettingsCard
      initialSnapshot={initialSnapshot}
      initialInspect={initialInspect}
      lifecycleClient={new HostLifecycleIpcClient(bridge)}
    />
  )
}

function viewProps(overrides: Partial<HostSettingsCardViewProps> = {}): HostSettingsCardViewProps {
  return {
    snapshot: lifecycle(),
    inspect: inspection(),
    pending: null,
    confirm: null,
    onAction: vi.fn(),
    onCancelConfirm: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides
  }
}

type Clickable = ReactElement<{ children?: ReactNode; onClick?: () => void }>

/**
 * The clickable element a person would press, found by its visible label
 * through nested arrays (a mapped button list is one).
 */
function findClickableByLabel(node: ReactNode, label: string): Clickable {
  const visit = (current: ReactNode): Clickable | null => {
    if (Array.isArray(current)) {
      for (const child of current) {
        const found = visit(child)
        if (found) return found
      }
      return null
    }
    if (!isValidElement<{ onClick?: unknown; children?: ReactNode }>(current)) return null
    if (typeof current.props.onClick === 'function' && current.props.children === label) {
      return current as Clickable
    }
    return visit(current.props.children)
  }
  const found = visit(node)
  if (!found) throw new Error(`No clickable element is labelled ${label}`)
  return found
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function projectedRuns(count: number): HostProjectionState {
  return {
    status: 'live',
    projection: {
      runs: Array.from({ length: count }, (_, index) => ({
        runId: `run-${index}`,
        threadId: 'thread-1',
        providerId: 'codex',
        providerOutcome: 'running'
      }))
    } as unknown as HostProjectedSnapshot
  }
}

/** Mount the real card hooks; capture its view props so no browser DOM is needed. */
async function mountCard(bridge: HostLifecycleBridge, initialProjection = projectedRuns(0)) {
  class TestElement {}
  class TestFrame extends TestElement {}
  const document = {
    nodeType: 9,
    activeElement: null,
    body: null,
    documentElement: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  const window = {
    document,
    event: undefined,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestFrame
  }
  Object.assign(document, { defaultView: window })
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: document,
    firstChild: null,
    lastChild: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    appendChild: () => undefined,
    removeChild: () => undefined
  } as unknown as Element
  let projected = initialProjection
  const listeners = new Set<(state: HostProjectionState) => void>()
  const store = {
    getState: () => projected,
    refresh: vi.fn(async () => undefined),
    subscribe: (listener: (state: HostProjectionState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  vi.spyOn(projectionProvider, 'useHostProjectionStore').mockReturnValue(
    store as unknown as HostProjectionStore
  )
  let lifecycleListener: (snapshot: HostLifecycleSnapshot) => void = () => undefined
  vi.mocked(bridge.onHostLifecycleChanged).mockImplementation((listener) => {
    lifecycleListener = listener
    return () => undefined
  })
  const client = new HostLifecycleIpcClient(bridge)
  const initialSnapshot = lifecycle()
  const initialInspect = inspection()
  let current: HostSettingsCardViewProps | undefined
  function Harness(): null {
    const element = HostSettingsCard({ initialSnapshot, initialInspect, lifecycleClient: client })
    current = element.props as HostSettingsCardViewProps
    return null
  }
  await act(async () => {
    mountedRoot = createRoot(container)
    mountedRoot.render(<Harness />)
  })
  const view = (): HostSettingsCardViewProps => {
    if (!current) throw new Error('Host card has not rendered')
    return current
  }
  return {
    view,
    click: async (label: string) => {
      await act(async () =>
        findClickableByLabel(HostSettingsCardView(view()), label).props.onClick?.()
      )
    },
    project: (next: HostProjectionState, notify = true) => {
      act(() => {
        projected = next
        if (notify) for (const listener of listeners) listener(next)
      })
    },
    lifecycle: async (next: HostLifecycleSnapshot) => {
      await act(async () => lifecycleListener(next))
    }
  }
}

afterEach(() => {
  act(() => mountedRoot?.unmount())
  mountedRoot = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('HostSettingsCard · first paint from props', () => {
  it('renders pid, payload hash, uptime, phase, holders, lease and every client', () => {
    const bridge = silentBridge()
    const markup = renderCard(lifecycle(), inspection(), bridge)

    expect(markup).toContain('<dt>pid</dt><dd>4242</dd>')
    // Short hash in the cell, the full value on hover.
    expect(markup).toContain(
      `<dt>Payload</dt><dd class="settings-host-payload" title="${PAYLOAD}">abababababab</dd>`
    )
    expect(markup).toContain('<dt>Uptime</dt><dd>3h 12m</dd>')
    expect(markup).toContain('<dt>Phase</dt><dd>Held</dd>')
    expect(markup).toContain('<dt>Holders</dt><dd>2 holders · 1 implicit · 3 declined</dd>')
    expect(markup).toContain('<dt>This app&#x27;s lease</dt><dd>Held · app open</dd>')
    expect(markup).toContain(
      '<tr><td>taskwraith-desktop-lease</td><td>App</td><td>Holds lease</td><td>1m</td><td title="bootstrap, health">2</td></tr>'
    )
    expect(markup).toContain(
      '<tr><td>tui-7f3a</td><td>Terminal</td><td>Implicit (older build)</td><td>2h 5m</td><td title="bootstrap, snapshot, deltas">3</td></tr>'
    )
    // A paired phone arrives without its pair id; it is named, never guessed.
    expect(markup).toContain(
      '<tr><td>Studio iPhone</td><td>Paired device</td><td>Declined</td><td>42s</td><td title="bootstrap">1</td></tr>'
    )
    expect(markup).toContain('>Running in this app</span>')
    expect(markup).toContain(
      '<p class="settings-hint">The Host runs while TaskWraith or a TUI holds it, and stops about 45 s after the last one leaves, once live work drains.</p>'
    )
    // Nothing above needed an effect: the bridge was never asked.
    expect(bridge.hostLifecycleStatus).not.toHaveBeenCalled()
    expect(bridge.hostLifecycleInspect).not.toHaveBeenCalled()
  })

  it("shows the Host's own uptime, never this renderer's clock against startedAt", () => {
    // A renderer clock two days past startedAt would read "2d 3h" if the card
    // subtracted; the Host said 3h 12m, and that is what a person must see.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-25T15:00:00.000Z'))
    const markup = renderCard(lifecycle(), inspection())

    expect(markup).toContain('<dt>Uptime</dt><dd>3h 12m</dd>')
    expect(markup).not.toContain('2d 3h')
  })

  it('shows the pid from the lifecycle snapshot before the first inspect answers', () => {
    const markup = renderCard(lifecycle(), null)

    expect(markup).toContain('<dt>pid</dt><dd>4242</dd>')
    expect(markup).toContain('title="' + PAYLOAD + '">abababababab</dd>')
    expect(markup).toContain('<dt>Uptime</dt><dd>Checking…</dd>')
    expect(markup).toContain('<dt>Holders</dt><dd>Checking…</dd>')
    expect(markup).toContain('Attached clients')
    expect(markup).not.toContain('<table')
  })

  it('never presents a stopped Host’s last pid as a live fact', () => {
    const markup = renderCard(
      lifecycle({ phase: 'stopped', desired: 'stopped', reason: 'user-stop' }),
      inspection()
    )

    expect(markup).toContain('<dt>pid</dt><dd>Not running</dd>')
    expect(markup).not.toContain('4242')
    expect(markup).toContain('>Stopped by you</span>')
    expect(markup).not.toContain('tui-7f3a')
    expect(markup).not.toContain('Held · app open')
    expect(markup).not.toContain('3h 12m')
  })

  it.each([
    { pid: 777 },
    { startedAt: '2026-09-23T13:00:00.000Z' },
    { hostId: 'replacement-install' }
  ])('never shows an earlier inspection beside a changed lifecycle identity: %j', (identity) => {
    const next = lifecycle({ revision: 8, host: { ...lifecycle().host!, ...identity } })
    const markup = renderCard(next, inspection())

    expect(markup).toContain(`<dt>pid</dt><dd>${next.host!.pid}</dd>`)
    expect(markup).toContain('<dt>Uptime</dt><dd>Checking…</dd>')
    expect(markup).not.toContain('tui-7f3a')
    expect(markup).not.toContain('Held · app open')
  })

  it('rejects a Host status whose identity disagrees with its inspection lifecycle', () => {
    const markup = renderCard(lifecycle(), inspection({ host: hostStatus({ pid: 777 }) }))

    expect(markup).toContain('<dt>pid</dt><dd>4242</dd>')
    expect(markup).not.toContain('777')
    expect(markup).not.toContain('3h 12m')
    expect(markup).not.toContain('tui-7f3a')
  })

  it('counts down the last-lease grace in the Host’s own milliseconds', () => {
    const markup = renderCard(
      lifecycle(),
      inspection({
        host: hostStatus({
          lifetime: {
            phase: 'grace',
            graceRemainingMs: 32_000,
            holders: 0,
            implicitHolders: 0,
            declined: 1
          }
        })
      })
    )

    expect(markup).toContain('<dt>Phase</dt><dd>Grace · exits in 32s</dd>')
    expect(markup).toContain('<dt>Holders</dt><dd>0 holders · 0 implicit · 1 declined</dd>')
  })

  it('shows the upgrade note for a Host that predates leases', () => {
    const markup = renderCard(
      lifecycle(),
      inspection({ host: null, lease: { mode: 'legacy', held: false, reasons: [] } })
    )

    expect(markup).toContain(
      '<p class="settings-host-note" role="note">This Host predates lease support. Restart it to upgrade.</p>'
    )
    expect(markup).toContain('<dd>Legacy Host · no lease</dd>')
    expect(markup).toContain('<dt>Uptime</dt><dd>Not reported</dd>')
    // Its pid is still known from the discovery record the app probed.
    expect(markup).toContain('<dt>pid</dt><dd>4242</dd>')
  })

  it('renders an answer without Host status or lease as not available yet, never as an error', () => {
    const markup = renderCard(lifecycle(), inspection({ host: null, lease: null }))

    expect(HOST_FACT_NOT_AVAILABLE).toBe('Not available yet')
    // The pid is still the lifecycle snapshot's; every Host-reported fact waits.
    expect(markup).toContain('<dt>pid</dt><dd>4242</dd>')
    expect(markup).toContain('<dt>Uptime</dt><dd>Not available yet</dd>')
    expect(markup).toContain('<dt>Phase</dt><dd>Not available yet</dd>')
    expect(markup).toContain('<dt>Holders</dt><dd>Not available yet</dd>')
    expect(markup).toContain('<dt>This app&#x27;s lease</dt><dd>Not available yet</dd>')
    expect(markup).toContain(
      '<h4 id="settings-host-clients-title" class="sidebar-section-title">Attached clients</h4></div><p class="settings-hint">Not available yet</p>'
    )
    expect(markup).not.toContain('<table')
    // Not an error, not a failed inspect, and not a legacy Host.
    expect(markup).not.toContain('settings-host-error')
    expect(markup).not.toContain('role="alert"')
    expect(markup).not.toContain('Unavailable')
    expect(markup).not.toContain('Live Host status is unavailable')
    expect(markup).not.toContain('predates lease support')

    // Each half stands alone: a lease before the Host's status, and the reverse.
    const leaseFirst = renderCard(lifecycle(), inspection({ host: null }))
    expect(leaseFirst).toContain('<dt>Uptime</dt><dd>Not available yet</dd>')
    expect(leaseFirst).toContain('<dt>This app&#x27;s lease</dt><dd>Held · app open</dd>')
    const statusFirst = renderCard(lifecycle(), inspection({ lease: null }))
    expect(statusFirst).toContain('<dt>Uptime</dt><dd>3h 12m</dd>')
    expect(statusFirst).toContain('<dt>This app&#x27;s lease</dt><dd>Not available yet</dd>')
  })

  it('lets a persisted Host explain why it outlives its holders', () => {
    const markup = renderCard(lifecycle(), inspection({ host: hostStatus({ persist: true }) }))

    expect(markup).toContain('TASKWRAITH_HOST_PERSIST=1')
    expect(renderCard(lifecycle(), inspection())).not.toContain('TASKWRAITH_HOST_PERSIST=1')
  })
})

describe('HostSettingsCard · actions', () => {
  it('Restart, Stop and Start each dispatch their own action', () => {
    const onAction = vi.fn()
    const tree = HostSettingsCardView(viewProps({ onAction }))

    findClickableByLabel(tree, 'Restart Host').props.onClick?.()
    findClickableByLabel(tree, 'Stop Host').props.onClick?.()
    findClickableByLabel(tree, 'Start Host').props.onClick?.()

    expect(onAction.mock.calls).toEqual([
      ['restart', false],
      ['stop', false],
      ['start', false]
    ])
  })

  it('offers Restart and Stop while running and Start only once stopped', () => {
    const running = describeHostCardButtons(lifecycle(), null)
    expect(running.map((button) => [button.action, button.disabled])).toEqual([
      ['restart', false],
      ['stop', false],
      ['start', true]
    ])

    const stopped = describeHostCardButtons(
      lifecycle({ phase: 'stopped', desired: 'stopped', reason: 'user-stop' }),
      null
    )
    expect(stopped.map((button) => [button.action, button.disabled])).toEqual([
      ['restart', true],
      ['stop', true],
      ['start', false]
    ])

    const restarting = describeHostCardButtons(lifecycle(), 'restart')
    expect(restarting.map((button) => [button.label, button.disabled])).toEqual([
      ['Restarting…', true],
      ['Stop Host', true],
      ['Start Host', true]
    ])
    expect(describeHostCardButtons(null, null).every((button) => button.disabled)).toBe(true)

    const markup = renderToStaticMarkup(
      HostSettingsCardView(
        viewProps({ snapshot: lifecycle({ phase: 'stopped', desired: 'stopped' }) })
      )
    )
    expect(markup).toMatch(/<button[^>]*settings-host-action--start"[^>]*>Start Host<\/button>/)
    expect(markup).toMatch(/<button[^>]*settings-host-action--restart"[^>]*disabled=""/)
  })

  it('asks before a restart while runs are live or uncounted, as the menu’s Restart Host does', () => {
    expect(planHostCardAction('restart', 2)).toEqual({
      kind: 'confirm',
      message: '2 runs are in progress. Restarting the Host cancels them.'
    })
    expect(planHostCardAction('restart', 1)).toEqual({
      kind: 'confirm',
      message: '1 run is in progress. Restarting the Host cancels it.'
    })
    // A count nothing can give is not a count of zero.
    expect(planHostCardAction('restart', null)).toEqual({
      kind: 'confirm',
      message:
        'TaskWraith cannot tell whether runs are in progress. Restarting the Host cancels any that are.'
    })
    expect(planHostCardAction('restart', 2, true)).toEqual({ kind: 'dispatch' })
    expect(planHostCardAction('restart', null, true)).toEqual({ kind: 'dispatch' })
    expect(planHostCardAction('restart', 0)).toEqual({ kind: 'dispatch' })
    // Only the restart asks; Stop keeps the behaviour of every other Stop Host.
    expect(planHostCardAction('stop', 3)).toEqual({ kind: 'dispatch' })
    expect(planHostCardAction('stop', null)).toEqual({ kind: 'dispatch' })
    expect(planHostCardAction('start', null)).toEqual({ kind: 'dispatch' })
  })

  it('confirms or keeps running from the question it shows', () => {
    const onAction = vi.fn()
    const onCancelConfirm = vi.fn()
    const message = '2 runs are in progress. Restarting the Host cancels them.'
    const props = viewProps({ confirm: message, onAction, onCancelConfirm })

    expect(renderToStaticMarkup(HostSettingsCardView(props))).toContain(
      `<div class="settings-host-confirm" role="alert"><span>${message}</span>`
    )
    const tree = HostSettingsCardView(props)
    findClickableByLabel(tree, 'Restart anyway').props.onClick?.()
    findClickableByLabel(tree, 'Keep running').props.onClick?.()

    expect(onAction).toHaveBeenCalledWith('restart', true)
    expect(onCancelConfirm).toHaveBeenCalledTimes(1)
  })

  it('counts the larger live-work observation without treating unavailable counts as zero', () => {
    const projected = (outcomes: string[]): HostProjectionState => ({
      status: 'live',
      projection: {
        runs: outcomes.map((providerOutcome, index) => ({
          runId: `run-${index}`,
          threadId: 'thread-1',
          providerId: 'codex',
          providerOutcome
        }))
      } as unknown as HostProjectedSnapshot
    })

    // Either source may discover a live run before the other does.
    expect(countLiveHostRuns(projected(['completed']), hostStatus({ liveWork: { runs: 3 } }))).toBe(
      3
    )
    expect(countLiveHostRuns(projected(['running', 'running']), hostStatus())).toBe(2)
    expect(countLiveHostRuns({ status: 'idle' }, hostStatus({ liveWork: { runs: 1 } }))).toBe(1)
    // Without it, the update-restart barrier's rule over the projection.
    expect(countLiveHostRuns(projected(['running', 'completed', 'running']), null)).toBe(2)
    expect(countLiveHostRuns(projected([]), null)).toBe(0)
    expect(countLiveHostRuns({ status: 'idle' }, null)).toBeNull()
  })
})

describe('HostSettingsCard · interactive lifecycle', () => {
  it('re-inspects on restart click and confirms projected work even when fresh Host status says zero', async () => {
    const bridge = silentBridge()
    const card = await mountCard(bridge)
    const inspect = vi.mocked(bridge.hostLifecycleInspect!)
    const callsBefore = inspect.mock.calls.length
    card.project(projectedRuns(2))

    await card.click('Restart Host')

    expect(inspect).toHaveBeenCalledTimes(callsBefore + 1)
    expect(card.view().confirm).toBe('2 runs are in progress. Restarting the Host cancels them.')
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
    await card.click('Keep running')
    expect(card.view().confirm).toBeNull()
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
  })

  it('uses fresh Host work rather than the cached idle inspection before dispatching a confirmed restart', async () => {
    const bridge = silentBridge()
    const card = await mountCard(bridge)
    vi.mocked(bridge.hostLifecycleInspect!).mockResolvedValueOnce({
      ok: true,
      ...inspection({ host: hostStatus({ liveWork: { runs: 3 } }) })
    })

    await card.click('Restart Host')

    expect(card.view().confirm).toBe('3 runs are in progress. Restarting the Host cancels them.')
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
    await card.click('Restart anyway')
    expect(bridge.hostLifecycleSet).toHaveBeenCalledExactlyOnceWith({ action: 'restart' })
  })

  it('reads the latest projection after a pending inspect and prevents duplicate restart reads', async () => {
    const bridge = silentBridge()
    const card = await mountCard(bridge)
    const answer = deferred<HostLifecycleInspectResult>()
    const inspect = vi.mocked(bridge.hostLifecycleInspect!)
    const callsBefore = inspect.mock.calls.length
    inspect.mockReturnValueOnce(answer.promise)

    await card.click('Restart Host')
    await card.click('Restart Host')
    card.project(projectedRuns(1), false)
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
    await act(async () => answer.resolve({ ok: true, ...inspection() }))

    expect(inspect).toHaveBeenCalledTimes(callsBefore + 1)
    expect(card.view().confirm).toBe('1 run is in progress. Restarting the Host cancels it.')
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
  })

  it('dispatches an idle restart only after the click-time inspection answers', async () => {
    const bridge = silentBridge()
    const card = await mountCard(bridge)
    const answer = deferred<HostLifecycleInspectResult>()
    vi.mocked(bridge.hostLifecycleInspect!).mockReturnValueOnce(answer.promise)

    await card.click('Restart Host')
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
    await act(async () => answer.resolve({ ok: true, ...inspection() }))

    expect(card.view().confirm).toBeNull()
    expect(bridge.hostLifecycleSet).toHaveBeenCalledExactlyOnceWith({ action: 'restart' })
  })

  it.each([
    {
      change: 'stopped',
      next: inspection({
        snapshot: lifecycle({
          revision: 8,
          phase: 'stopped',
          desired: 'stopped',
          reason: 'user-stop'
        }),
        host: null,
        lease: null
      })
    },
    {
      change: 'replacement',
      next: inspection({
        snapshot: lifecycle({
          revision: 8,
          host: {
            ...lifecycle().host!,
            pid: 777,
            hostId: 'replacement-host',
            startedAt: '2026-09-24T12:05:00.000Z'
          }
        }),
        host: hostStatus({
          pid: 777,
          hostId: 'replacement-host',
          startedAt: '2026-09-24T12:05:00.000Z'
        })
      })
    },
    {
      change: 'new lifecycle revision',
      next: inspection({ snapshot: lifecycle({ revision: 8 }) })
    },
    {
      change: 'stale lifecycle revision',
      next: inspection({ snapshot: lifecycle({ revision: 6 }) })
    }
  ])('cancels restart when click-time inspection itself returns $change', async ({ next }) => {
    const bridge = silentBridge()
    const card = await mountCard(bridge)
    const answer = deferred<HostLifecycleInspectResult>()
    vi.mocked(bridge.hostLifecycleInspect!).mockReturnValueOnce(answer.promise)

    await card.click('Restart Host')
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
    await act(async () => answer.resolve({ ok: true, ...next }))

    expect(card.view().snapshot?.revision).toBe(Math.max(7, next.snapshot.revision))
    expect(card.view().snapshot?.phase).toBe(next.snapshot.phase)
    expect(card.view().confirm).toBeNull()
    expect(card.view().pending).toBeNull()
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
  })

  it('asks when click-time inspection fails even with an idle projected count', async () => {
    const bridge = silentBridge()
    const card = await mountCard(bridge)
    vi.mocked(bridge.hostLifecycleInspect!).mockRejectedValueOnce(new Error('Host status failed'))

    await card.click('Restart Host')

    expect(card.view().confirm).toContain('cannot tell whether runs are in progress')
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
  })

  it('asks when click-time inspection fails and no projected count is available', async () => {
    const bridge = silentBridge()
    const card = await mountCard(bridge, { status: 'idle' })
    vi.mocked(bridge.hostLifecycleInspect!).mockRejectedValueOnce(new Error('Host status failed'))

    await card.click('Restart Host')

    expect(card.view().confirm).toContain('cannot tell whether runs are in progress')
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
  })

  it('does not dispatch a pending restart check after a stopped lifecycle arrives', async () => {
    const bridge = silentBridge()
    const card = await mountCard(bridge)
    const answer = deferred<HostLifecycleInspectResult>()
    const stopped = lifecycle({
      revision: 8,
      phase: 'stopped',
      desired: 'stopped',
      reason: 'user-stop'
    })
    vi.mocked(bridge.hostLifecycleInspect!)
      .mockReturnValueOnce(answer.promise)
      .mockResolvedValue({
        ok: true,
        ...inspection({ snapshot: stopped, host: null, lease: null })
      })

    await card.click('Restart Host')
    await card.lifecycle(stopped)
    await act(async () => answer.resolve({ ok: true, ...inspection() }))

    expect(card.view().snapshot?.phase).toBe('stopped')
    expect(card.view().inspect).toBeNull()
    expect(card.view().confirm).toBeNull()
    expect(bridge.hostLifecycleSet).not.toHaveBeenCalled()
    const markup = renderToStaticMarkup(HostSettingsCardView(card.view()))
    expect(markup).not.toContain('4242')
    expect(markup).not.toContain('Held · app open')
    expect(markup).not.toContain('tui-7f3a')
  })

  it('clears old inspection errors and ignores an old read while a replacement inspection is pending', async () => {
    const bridge = silentBridge()
    const card = await mountCard(bridge)
    const inspect = vi.mocked(bridge.hostLifecycleInspect!)
    inspect.mockRejectedValueOnce(new Error('old Host error'))
    await card.click('Refresh')
    expect(card.view().inspectError).toBe('old Host error')
    const oldAnswer = deferred<HostLifecycleInspectResult>()
    const newAnswer = deferred<HostLifecycleInspectResult>()
    inspect.mockReturnValueOnce(oldAnswer.promise).mockReturnValueOnce(newAnswer.promise)
    await card.click('Refresh')
    const replacementHost = hostStatus({
      pid: 777,
      startedAt: '2026-09-23T13:00:00.000Z',
      clients: []
    })
    const replacement = lifecycle({
      revision: 8,
      host: {
        ...lifecycle().host!,
        pid: replacementHost.pid,
        startedAt: replacementHost.startedAt
      }
    })

    await card.lifecycle(replacement)

    expect(card.view().inspect).toBeNull()
    expect(card.view().inspectError).toBeUndefined()
    let markup = renderToStaticMarkup(HostSettingsCardView(card.view()))
    expect(markup).toContain('<dt>pid</dt><dd>777</dd>')
    expect(markup).not.toContain('tui-7f3a')
    expect(markup).not.toContain('old Host error')
    await act(async () => oldAnswer.reject(new Error('late old Host failure')))
    expect(card.view().inspectError).toBeUndefined()
    await act(async () =>
      newAnswer.resolve({
        ok: true,
        ...inspection({ snapshot: replacement, host: replacementHost })
      })
    )

    markup = renderToStaticMarkup(HostSettingsCardView(card.view()))
    expect(markup).toContain('<dt>pid</dt><dd>777</dd>')
    expect(markup).toContain('No clients are attached.')
    expect(markup).not.toContain('late old Host failure')
  })
})

describe('HostSettingsCard · small helpers', () => {
  it('shortens the payload hash to twelve hex digits', () => {
    expect(shortHostPayload(`sha256:${'0123456789abcdef'.repeat(4)}`)).toBe('0123456789ab')
  })

  it('names this app’s lease honestly in every mode', () => {
    expect(describeHostAppLease(null)).toBe('Not available yet')
    expect(describeHostAppLease({ mode: 'legacy', held: false, reasons: [] })).toBe(
      'Legacy Host · no lease'
    )
    expect(describeHostAppLease({ mode: 'lease', held: false, reasons: [] })).toBe('Not held')
    expect(
      describeHostAppLease({ mode: 'lease', held: true, reasons: ['window', 'work', 'pin'] })
    ).toBe('Held · window open, live work, phone pinned')
  })
})

describe('HostSettingsCard · source pin', () => {
  it('paints from state seeded by its props, never from a ref', () => {
    const probe = new MainSourceProbe(
      'HostSettingsCard.tsx',
      new URL('./HostSettingsCard.tsx', import.meta.url)
    )
    const body = probe.fn('HostSettingsCard')

    // Async request bookkeeping may use a ref. Rendered facts must still use
    // `const [x, setX] = useState<...>(seed)` for each seed, and the view reads x.
    const stateFromSeed = (seed: string): string => {
      const call = probe.callsTo(body, 'useState').find((each) => probe.argText(each, 0) === seed)
      if (
        !call ||
        !ts.isVariableDeclaration(call.parent) ||
        !ts.isArrayBindingPattern(call.parent.name)
      ) {
        throw new Error(`HostSettingsCard does not seed a useState from ${seed}`)
      }
      const [first] = call.parent.name.elements
      if (!first || !ts.isBindingElement(first) || !ts.isIdentifier(first.name)) {
        throw new Error(`the useState seeded from ${seed} binds no value`)
      }
      return first.name.text
    }
    const viewAttributes = new Map<string, string>()
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        probe.text(node.tagName) === 'HostSettingsCardView'
      ) {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.initializer) {
            viewAttributes.set(probe.text(attribute.name), probe.text(attribute.initializer))
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(body)

    expect(viewAttributes.get('snapshot')).toBe(`{${stateFromSeed('initialSnapshot')}}`)
    expect(viewAttributes.get('inspect')).toBe(`{${stateFromSeed('initialInspect')}}`)
  })
})
