/**
 * Settings → TaskWraith Host.
 *
 * The one surface that shows the Host process itself: which process it is
 * (pid, payload hash, uptime), why it is still running (its lifetime phase and
 * lease holders, implicit and declined included), this app's own lease, and
 * every client attached to it, with Restart, Stop and Start.
 *
 * FIRST PAINT IS DECLARATIVE. Renderer suites render through
 * `renderToStaticMarkup`, where effects never run and refs never attach, and
 * the real first paint has the same constraint. The card therefore renders the
 * lifecycle snapshot and the last inspect answer from STATE seeded by its
 * props; the mount effects only overwrite them. A source pin in the test holds
 * this, because a ref-fed first paint would render blank without failing.
 *
 * DURATIONS COME FROM THE HOST'S CLOCK. Uptime, connection ages and the grace
 * countdown are the Host's own numbers from `host.status`, never this
 * renderer's `Date.now()` measured against `startedAt`.
 *
 * RESTART CONFIRMS WHILE RUNS ARE LIVE OR UNCOUNTED, by the rule of the
 * menu's Restart Host (`createHostRestartAction`): the Host's own live-work
 * count read when Restart is clicked and the current projected runs whose
 * provider outcome is still `running`, taking the larger count. A count
 * neither source can give asks too.
 *
 * AN ABSENT FACT IS NEVER AN ERROR. An inspect answer may carry no Host status
 * (the lease socket has not connected yet) or no lease; those facts read "Not
 * available yet", and only a failed inspect reads as unavailable.
 */

import { useEffect, useRef, useState } from 'react'

import type {
  HostLeaseReasonKind,
  HostLifecycleAction,
  HostLifecycleLeaseProjection,
  HostLifecycleSnapshot
} from '../../../shared/hostLifecycle'
import type {
  HostClientClass,
  HostClientLeaseState,
  HostStatusClientProjection,
  HostStatusLifetimeProjection,
  HostStatusProjection
} from '../../../shared/hostProtocol'
import { useHostProjection } from '../hooks/useHostProjection'
import {
  HostLifecycleIpcClient,
  type HostLifecycleInspection
} from '../lib/host/hostLifecycleIpcClient'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import { useHostProjectionStore } from './HostProjectionProvider'
import {
  HOST_LEASE_LIFETIME_NOTE,
  describeHostLifecycleControl,
  formatHostDuration
} from './HostStatusRow'
import { PillButton } from './PillButton'
import './HostSettingsCard.css'

/** The payload hash in a glance: its first twelve hex digits. */
export function shortHostPayload(payloadVersion: string): string {
  const hex = payloadVersion.startsWith('sha256:')
    ? payloadVersion.slice('sha256:'.length)
    : payloadVersion
  return hex.slice(0, 12)
}

/** Why the Host is still up, in its own words (`host.status` lifetime phase). */
function describeHostLifetime(lifetime: HostStatusLifetimeProjection): string {
  switch (lifetime.phase) {
    case 'held':
      return 'Held'
    case 'grace':
      return lifetime.graceRemainingMs === undefined
        ? 'Grace'
        : `Grace · exits in ${formatHostDuration(lifetime.graceRemainingMs)}`
    case 'draining':
      return 'Draining live work'
    case 'stopping':
      return 'Stopping'
  }
}

/** Holders are explicit plus implicit; the implicit and declined counts stay visible. */
function describeHostHolders(lifetime: HostStatusLifetimeProjection): string {
  const holders = `${lifetime.holders} ${lifetime.holders === 1 ? 'holder' : 'holders'}`
  return `${holders} · ${lifetime.implicitHolders} implicit · ${lifetime.declined} declined`
}

const LEASE_REASON_LABELS: Record<HostLeaseReasonKind, string> = {
  app: 'app open',
  window: 'window open',
  work: 'live work',
  pin: 'phone pinned'
}

/** How the card writes a fact the inspect answer did not carry. */
export const HOST_FACT_NOT_AVAILABLE = 'Not available yet'

/** This app's own lease: its mode and, when held, the reasons it is held for. */
export function describeHostAppLease(lease: HostLifecycleLeaseProjection | null): string {
  if (!lease) return HOST_FACT_NOT_AVAILABLE
  if (lease.mode === 'legacy') return 'Legacy Host · no lease'
  if (!lease.held) return 'Not held'
  if (lease.reasons.length === 0) return 'Held'
  return `Held · ${lease.reasons.map((reason) => LEASE_REASON_LABELS[reason]).join(', ')}`
}

const CLIENT_CLASS_LABELS: Record<HostClientClass, string> = {
  desktop: 'App',
  tui: 'Terminal',
  ios: 'Paired device',
  test: 'Test',
  'host-cli': 'Command line'
}

const CLIENT_LEASE_LABELS: Record<HostClientLeaseState, string> = {
  explicit: 'Holds lease',
  implicit: 'Implicit (older build)',
  declined: 'Declined',
  none: 'None'
}

interface HostSettingsClientRow {
  readonly key: string
  readonly name: string
  readonly kind: string
  readonly lease: string
  readonly connected: string
  readonly capabilityCount: string
  readonly capabilities: string
}

/** One row per attached client. A paired phone carries no client id by design. */
function describeHostClients(
  clients: readonly HostStatusClientProjection[]
): HostSettingsClientRow[] {
  return clients.map((client, index) => ({
    key: `${client.clientClass}:${client.clientId ?? client.displayName ?? ''}:${index}`,
    name: client.displayName ?? client.clientId ?? CLIENT_CLASS_LABELS[client.clientClass],
    kind: CLIENT_CLASS_LABELS[client.clientClass],
    lease: CLIENT_LEASE_LABELS[client.lease],
    connected: formatHostDuration(client.connectedForMs),
    capabilityCount: String(client.capabilities.length),
    capabilities: client.capabilities.join(', ')
  }))
}

/**
 * Either source can see work before the other. Never let one source's zero
 * erase live work the other already knows about; absent counts stay unknown.
 */
export function countLiveHostRuns(
  projection: HostProjectionState,
  host: HostStatusProjection | null
): number | null {
  const projected = projection.projection
    ? projection.projection.runs.filter((run) => run.providerOutcome === 'running').length
    : null
  return host ? Math.max(host.liveWork.runs, projected ?? 0) : projected
}

/** An inspection can describe only the running lifecycle that supplied it. */
function currentHostInspection(
  snapshot: HostLifecycleSnapshot | null,
  inspect: HostLifecycleInspection | null
): HostLifecycleInspection | null {
  if (snapshot?.phase !== 'running' || inspect?.snapshot.phase !== 'running') return null
  const identity = snapshot.host
  const inspectedIdentity = inspect.snapshot.host
  if (!identity || !inspectedIdentity) {
    // The in-process Host has no lifecycle identity; a revision change then
    // invalidates the entire old answer instead of guessing its process.
    return !identity && !inspectedIdentity && snapshot.revision === inspect.snapshot.revision
      ? inspect
      : null
  }
  const matches = (candidate: { pid: number; startedAt: string; hostId: string }): boolean =>
    candidate.pid === identity.pid &&
    candidate.startedAt === identity.startedAt &&
    candidate.hostId === identity.hostId
  return matches(inspectedIdentity) && (!inspect.host || matches(inspect.host)) ? inspect : null
}

export type HostCardActionPlan =
  | { readonly kind: 'dispatch' }
  | { readonly kind: 'confirm'; readonly message: string }

/**
 * Only a restart asks first, and only while runs are live or their count is
 * unknown; a confirmed restart dispatches. The question is the menu's.
 */
export function planHostCardAction(
  action: HostLifecycleAction,
  liveRuns: number | null,
  confirmed = false
): HostCardActionPlan {
  if (action !== 'restart' || confirmed || (liveRuns !== null && liveRuns <= 0)) {
    return { kind: 'dispatch' }
  }
  if (liveRuns === null) {
    return {
      kind: 'confirm',
      message:
        'TaskWraith cannot tell whether runs are in progress. Restarting the Host cancels any that are.'
    }
  }
  const runs = `${liveRuns} run${liveRuns === 1 ? ' is' : 's are'}`
  return {
    kind: 'confirm',
    message: `${runs} in progress. Restarting the Host cancels ${liveRuns === 1 ? 'it' : 'them'}.`
  }
}

export interface HostCardButton {
  readonly action: HostLifecycleAction
  readonly label: string
  readonly disabled: boolean
}

/** Restart while running (or after a failure), Stop while running, Start while stopped. */
export function describeHostCardButtons(
  snapshot: HostLifecycleSnapshot | null,
  pending: HostLifecycleAction | null
): readonly HostCardButton[] {
  const phase = snapshot?.phase
  const settled =
    snapshot !== null && pending === null && phase !== 'starting' && phase !== 'stopping'
  const failedWanting = (desired: HostLifecycleSnapshot['desired']): boolean =>
    phase === 'failed' && snapshot?.desired === desired
  return [
    {
      action: 'restart',
      label: pending === 'restart' ? 'Restarting…' : 'Restart Host',
      disabled: !(settled && (phase === 'running' || phase === 'failed'))
    },
    {
      action: 'stop',
      label: pending === 'stop' ? 'Stopping…' : 'Stop Host',
      disabled: !(settled && (phase === 'running' || failedWanting('stopped')))
    },
    {
      action: 'start',
      label: pending === 'start' ? 'Starting…' : 'Start Host',
      disabled: !(settled && (phase === 'stopped' || failedWanting('running')))
    }
  ]
}

/** What an unknown Host fact says, so an absence is never dressed as a value. */
function describeMissingHostFact(
  snapshot: HostLifecycleSnapshot | null,
  inspect: HostLifecycleInspection | null,
  inspectError: string | undefined
): string {
  if (snapshot?.phase === 'starting') return 'Starting…'
  if (snapshot?.phase === 'stopping') return 'Stopping…'
  if (snapshot && snapshot.phase !== 'running') return 'Not running'
  if (inspectError) return 'Unavailable'
  if (!inspect) return 'Checking…'
  // A Host that predates leases never reports these; any other answer without
  // them is one the Host has not given yet.
  return inspect.lease?.mode === 'legacy' ? 'Not reported' : HOST_FACT_NOT_AVAILABLE
}

export interface HostSettingsCardViewProps {
  readonly snapshot: HostLifecycleSnapshot | null
  readonly inspect: HostLifecycleInspection | null
  readonly inspectError?: string
  readonly lifecycleError?: string
  readonly actionError?: string
  readonly pending: HostLifecycleAction | null
  /** The restart confirmation awaiting an answer, when there is one. */
  readonly confirm: string | null
  readonly onAction: (action: HostLifecycleAction, confirmed: boolean) => void
  readonly onCancelConfirm: () => void
  readonly onRefresh: () => void
}

/** Pure view: everything it paints arrives in props. */
export function HostSettingsCardView({
  snapshot,
  inspect,
  inspectError,
  lifecycleError,
  actionError,
  pending,
  confirm,
  onAction,
  onCancelConfirm,
  onRefresh
}: HostSettingsCardViewProps): React.JSX.Element {
  const currentInspect = currentHostInspection(snapshot, inspect)
  const host = currentInspect?.host ?? null
  // The snapshot's identity block is the pid before the first inspect, and
  // only while the Host runs: a stopped Host's last pid is not a live fact.
  const identity = snapshot?.phase === 'running' ? snapshot.host : undefined
  const visibleInspectError =
    snapshot?.phase === 'running' && (!inspect || currentInspect) ? inspectError : undefined
  const missing = describeMissingHostFact(snapshot, currentInspect, visibleInspectError)
  const pid = host?.pid ?? identity?.pid
  const payload = host ? host.payloadVersion : identity?.payloadVersion
  const control = describeHostLifecycleControl(snapshot, pending !== null, lifecycleError)
  const buttons = describeHostCardButtons(snapshot, pending)
  const clients = host ? describeHostClients(host.clients) : null
  const lease = currentInspect ? describeHostAppLease(currentInspect.lease) : missing

  return (
    <div className="settings-host-page">
      <section className="settings-group settings-host-card" aria-labelledby="settings-host-title">
        <div className="settings-section-title-row">
          <h4 id="settings-host-title" className="sidebar-section-title">
            TaskWraith Host
          </h4>
          <span className="settings-scope-pill" role="status" aria-live="polite">
            {control.stateLabel}
          </span>
        </div>
        <p className="settings-hint">{HOST_LEASE_LIFETIME_NOTE}</p>
        {currentInspect?.lease?.mode === 'legacy' ? (
          <p className="settings-host-note" role="note">
            This Host predates lease support. Restart it to upgrade.
          </p>
        ) : null}
        {host?.persist ? (
          <p className="settings-host-note" role="note">
            Grace exit is off for this Host (TASKWRAITH_HOST_PERSIST=1): it keeps running after its
            last holder leaves.
          </p>
        ) : null}
        <dl className="settings-host-facts">
          <div className="settings-host-fact">
            <dt>pid</dt>
            <dd>{pid === undefined ? missing : String(pid)}</dd>
          </div>
          <div className="settings-host-fact">
            <dt>Payload</dt>
            {payload ? (
              <dd className="settings-host-payload" title={payload}>
                {shortHostPayload(payload)}
              </dd>
            ) : (
              <dd>{host ? 'Not published' : missing}</dd>
            )}
          </div>
          <div className="settings-host-fact">
            <dt>Uptime</dt>
            <dd>{host ? formatHostDuration(host.uptimeMs) : missing}</dd>
          </div>
          <div className="settings-host-fact">
            <dt>Phase</dt>
            <dd>{host ? describeHostLifetime(host.lifetime) : missing}</dd>
          </div>
          <div className="settings-host-fact">
            <dt>Holders</dt>
            <dd>{host ? describeHostHolders(host.lifetime) : missing}</dd>
          </div>
          <div className="settings-host-fact">
            <dt>This app&apos;s lease</dt>
            <dd>{lease}</dd>
          </div>
        </dl>
        <div className="settings-host-actions">
          {buttons.map((button) => (
            <PillButton
              key={button.action}
              size="compact"
              variant={button.action === 'stop' ? 'danger' : 'secondary'}
              className={`settings-host-action settings-host-action--${button.action}`}
              disabled={button.disabled}
              loading={pending === button.action}
              onClick={() => onAction(button.action, false)}
            >
              {button.label}
            </PillButton>
          ))}
          <PillButton
            size="compact"
            variant="ghost"
            className="settings-host-action settings-host-action--refresh"
            onClick={onRefresh}
          >
            Refresh
          </PillButton>
        </div>
        {confirm ? (
          <div className="settings-host-confirm" role="alert">
            <span>{confirm}</span>
            <PillButton
              size="compact"
              variant="danger"
              className="settings-host-confirm-restart"
              onClick={() => onAction('restart', true)}
            >
              Restart anyway
            </PillButton>
            <PillButton
              size="compact"
              variant="secondary"
              className="settings-host-confirm-cancel"
              onClick={onCancelConfirm}
            >
              Keep running
            </PillButton>
          </div>
        ) : null}
        {actionError ? (
          <p className="settings-host-error" role="status">
            {actionError}
          </p>
        ) : null}
        {lifecycleError ? (
          <p className="settings-host-error" role="status">
            Host control is unavailable: {lifecycleError}
          </p>
        ) : null}
        {visibleInspectError ? (
          <p className="settings-hint" role="status">
            Live Host status is unavailable: {visibleInspectError}
            {currentInspect ? ' Showing the last answer.' : ''}
          </p>
        ) : null}
      </section>

      <section
        className="settings-group settings-host-clients"
        aria-labelledby="settings-host-clients-title"
      >
        <div className="settings-section-title-row">
          <h4 id="settings-host-clients-title" className="sidebar-section-title">
            Attached clients
          </h4>
          {clients ? <span className="settings-scope-pill">{clients.length}</span> : null}
        </div>
        {clients === null ? (
          <p className="settings-hint">{missing}</p>
        ) : clients.length === 0 ? (
          <p className="settings-hint">No clients are attached.</p>
        ) : (
          <div className="settings-host-client-scroll">
            <table className="settings-host-client-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Lease</th>
                  <th scope="col">Connected</th>
                  <th scope="col">Capabilities</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.key}>
                    <td>{client.name}</td>
                    <td>{client.kind}</td>
                    <td>{client.lease}</td>
                    <td>{client.connected}</td>
                    <td title={client.capabilities}>{client.capabilityCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function newerSnapshot(
  current: HostLifecycleSnapshot | null,
  next: HostLifecycleSnapshot
): HostLifecycleSnapshot {
  return !current || next.revision >= current.revision ? next : current
}

export interface HostSettingsCardProps {
  /** Seeds the first paint. Production passes neither and reads both on mount. */
  readonly initialSnapshot?: HostLifecycleSnapshot | null
  readonly initialInspect?: HostLifecycleInspection | null
  /** Injected only by tests; production resolves the preload conduit lazily. */
  readonly lifecycleClient?: HostLifecycleIpcClient
}

export function HostSettingsCard({
  initialSnapshot = null,
  initialInspect = null,
  lifecycleClient: injectedClient
}: HostSettingsCardProps = {}): React.JSX.Element {
  const store = useHostProjectionStore()
  const projection = useHostProjection(store)
  const [client] = useState(() => injectedClient ?? new HostLifecycleIpcClient())
  const [snapshot, setSnapshot] = useState<HostLifecycleSnapshot | null>(initialSnapshot)
  const [inspect, setInspect] = useState<HostLifecycleInspection | null>(initialInspect)
  const [inspectError, setInspectError] = useState<string | undefined>(undefined)
  const [lifecycleError, setLifecycleError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState<HostLifecycleAction | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  // Async reads use the latest event immediately; displayed facts still come
  // only from React state, including the declarative first paint above.
  const readsRef = useRef({
    snapshot: initialSnapshot,
    generation: 0,
    actionPending: false,
    mounted: true
  })
  // Bumped by a lifecycle event, a finished action or Refresh; each bump asks
  // main for a fresh inspect and retires the answer to the previous one.
  const [inspectRequest, setInspectRequest] = useState(0)

  const acceptSnapshot = (next: HostLifecycleSnapshot): boolean => {
    const reads = readsRef.current
    const current = reads.snapshot
    if (newerSnapshot(current, next) !== next) return false
    reads.snapshot = next
    setSnapshot(next)
    if (
      current?.revision !== next.revision ||
      current.phase !== next.phase ||
      current.host?.pid !== next.host?.pid ||
      current.host?.startedAt !== next.host?.startedAt ||
      current.host?.hostId !== next.host?.hostId
    ) {
      reads.generation += 1
      setInspect(null)
      setInspectError(undefined)
      setActionError(undefined)
      setConfirm(null)
    }
    return true
  }

  useEffect(() => {
    let alive = true
    const reads = readsRef.current
    reads.mounted = true
    const unsubscribe = client.subscribe((next) => {
      if (!alive) return
      if (acceptSnapshot(next)) {
        setLifecycleError(undefined)
        setInspectRequest((count) => count + 1)
      }
    })
    const requestedRevision = reads.snapshot?.revision
    void client.status().then(
      (next) => {
        if (!alive) return
        if (acceptSnapshot(next)) setInspectRequest((count) => count + 1)
        setLifecycleError(undefined)
      },
      (error: unknown) => {
        if (alive && reads.snapshot?.revision === requestedRevision) {
          setLifecycleError(errorMessage(error))
        }
      }
    )
    return () => {
      alive = false
      reads.mounted = false
      reads.generation += 1
      unsubscribe()
    }
  }, [client])

  useEffect(() => {
    let alive = true
    const reads = readsRef.current
    const generation = ++reads.generation
    void client.inspect().then(
      (next) => {
        if (!alive || generation !== reads.generation || !acceptSnapshot(next.snapshot)) return
        setInspect(currentHostInspection(reads.snapshot, next))
        setInspectError(undefined)
      },
      (error: unknown) => {
        if (alive && generation === reads.generation && reads.snapshot?.phase === 'running') {
          setInspectError(errorMessage(error))
        }
      }
    )
    return () => {
      alive = false
    }
  }, [client, inspectRequest])

  const requestAction = (action: HostLifecycleAction, confirmed: boolean): void => {
    const reads = readsRef.current
    if (pending !== null || reads.actionPending) return
    reads.actionPending = true
    setActionError(undefined)
    void (async () => {
      let dispatched = false
      try {
        if (action === 'restart' && !confirmed) {
          const target = reads.snapshot
          if (target?.phase !== 'running') return
          const generation = ++reads.generation
          let fresh: HostLifecycleInspection | null = null
          try {
            const next = await client.inspect()
            if (!reads.mounted || generation !== reads.generation) return
            // Accepting the answer may itself advance the lifecycle and invalidate this click.
            if (!acceptSnapshot(next.snapshot) || generation !== reads.generation) return
            fresh = currentHostInspection(target, next)
            if (!fresh) return
            setInspect(fresh)
            setInspectError(undefined)
          } catch (error) {
            if (!reads.mounted || generation !== reads.generation) return
            setInspectError(errorMessage(error))
          }
          const liveRuns = countLiveHostRuns(store?.getState() ?? projection, fresh?.host ?? null)
          const plan = planHostCardAction(
            action,
            fresh === null && liveRuns === 0 ? null : liveRuns,
            confirmed
          )
          if (plan.kind === 'confirm') {
            setConfirm(plan.message)
            return
          }
        }
        setConfirm(null)
        setPending(action)
        dispatched = true
        const result = await client.set(action)
        if (!reads.mounted) return
        if (result.snapshot) acceptSnapshot(result.snapshot)
        if (!result.ok) setActionError(result.error)
        void store?.refresh().catch(() => undefined)
      } catch (error) {
        if (reads.mounted) setActionError(errorMessage(error))
      } finally {
        reads.actionPending = false
        if (reads.mounted) {
          setPending(null)
          if (dispatched) setInspectRequest((count) => count + 1)
        }
      }
    })()
  }

  return (
    <HostSettingsCardView
      snapshot={snapshot}
      inspect={inspect}
      inspectError={inspectError}
      lifecycleError={lifecycleError}
      actionError={actionError}
      pending={pending}
      confirm={confirm}
      onAction={requestAction}
      onCancelConfirm={() => setConfirm(null)}
      onRefresh={() => setInspectRequest((count) => count + 1)}
    />
  )
}
