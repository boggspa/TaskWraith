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

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostLifecycleSnapshot } from '../../../shared/hostLifecycle'
import type { HostStatusProjection } from '../../../shared/hostProtocol'
import { MainSourceProbe } from '../../../main/mainSourceProbe.testutil'
import {
  HostLifecycleIpcClient,
  type HostLifecycleBridge,
  type HostLifecycleInspection
} from '../lib/host/hostLifecycleIpcClient'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import type { HostProjectedSnapshot } from '../lib/host/hostSnapshotProjection'
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

afterEach(() => {
  vi.restoreAllMocks()
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
      null
    )

    expect(markup).toContain('<dt>pid</dt><dd>Not running</dd>')
    expect(markup).not.toContain('4242')
    expect(markup).toContain('>Stopped by you</span>')
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

  it('counts live runs as the menu does: the Host’s own count first, then the projection', () => {
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

    // The Host's own status wins whenever it is known, above or below the projection.
    expect(countLiveHostRuns(projected(['completed']), hostStatus({ liveWork: { runs: 3 } }))).toBe(
      3
    )
    expect(countLiveHostRuns(projected(['running', 'running']), hostStatus())).toBe(0)
    expect(countLiveHostRuns({ status: 'idle' }, hostStatus({ liveWork: { runs: 1 } }))).toBe(1)
    // Without it, the update-restart barrier's rule over the projection.
    expect(countLiveHostRuns(projected(['running', 'completed', 'running']), null)).toBe(2)
    expect(countLiveHostRuns(projected([]), null)).toBe(0)
    expect(countLiveHostRuns({ status: 'idle' }, null)).toBeNull()
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

    // Refs never attach under SSR and a ref read in render is invisible to
    // every static-markup test, so the container holds no ref at all.
    expect(probe.callsTo(body, 'useRef')).toEqual([])

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

    // The container's glue: every click goes through the plan, and a dispatch
    // sends exactly the action that was planned.
    const plans = probe.callsTo(body, 'planHostCardAction')
    expect(plans.map((call) => probe.argText(call, 0))).toEqual(['action'])
    expect(plans.map((call) => probe.argText(call, 1))).toEqual(['liveRuns'])
    const counts = probe.callsTo(body, 'countLiveHostRuns')
    expect(counts.map((call) => [probe.argText(call, 0), probe.argText(call, 1)])).toEqual([
      ['projection', 'inspect?.host ?? null']
    ])
    const sets = probe.callsTo(body, 'set')
    expect(sets.map((call) => probe.argText(call, 0))).toEqual(['action'])
  })
})
