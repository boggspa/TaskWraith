/**
 * The TUI's `/host` verb and the Host lines `/status` gains: argument parsing,
 * and pure builders that turn what the controller already holds (this
 * connection's discovery identity, a `host.status` read, the lease state, a
 * stop-all plan and its results) into the lens `render.ts` draws as given.
 * Nothing here talks to a Host or a process.
 */

import {
  HOST_TERMINATION_SUCCESS_KINDS,
  type HostTerminationOutcome
} from '../host-client/HostProcessTermination'
import type { HostProjectionDiscoveryProcessIdentity } from '../host-client/HostProjectionClient'
import type { HostStopAllHost, HostStopAllScope } from '../host-client/HostStopAll'
import { HostProductionCliError, parseHostProductionCli } from '../host-runtime/HostProductionCli'
import type { HostStatusProjection } from '../shared/hostProtocol'
import type {
  TuiHostStopAllOutcome,
  TuiHostStopAllPlan,
  TuiHostStopAllRequest
} from './hostProcessManager'
import type { TuiHostPanel, TuiHostPanelHost } from './state'

/** Whether this TUI holds a lease on its Host: `legacy` is a Host from before leases. */
export type TuiHostLeaseState = 'none' | 'held' | 'legacy'

export type TuiHostCommand =
  | { readonly verb: 'status' }
  | { readonly verb: 'restart' }
  | { readonly verb: 'stop-all'; readonly request: TuiHostStopAllRequest }
  | { readonly verb: 'invalid'; readonly message: string }

const PATH_FLAGS = new Set(['--profile', '--payload-root'])

/**
 * Splits `/host` arguments. Quotes group; an unquoted value after `--profile`
 * or `--payload-root` runs to the next ` --flag` or the end, so a profile under
 * `Application Support` stays one argument without quoting.
 */
export function tokenizeTuiHostArguments(text: string): string[] {
  const tokens: string[] = []
  let rest = text.trim()
  let pathValue = false
  while (rest) {
    let token: string
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : null
    if (quote) {
      const close = rest.indexOf(quote, 1)
      token = close > 0 ? rest.slice(1, close) : rest.slice(1)
      rest = close > 0 ? rest.slice(close + 1) : ''
    } else {
      const end = pathValue ? rest.search(/\s--/) : rest.search(/\s/)
      token = (end >= 0 ? rest.slice(0, end) : rest).trimEnd()
      rest = end >= 0 ? rest.slice(end) : ''
    }
    tokens.push(token)
    pathValue = !quote && PATH_FLAGS.has(token)
    rest = rest.trimStart()
  }
  return tokens
}

function invalid(message: string): TuiHostCommand {
  return { verb: 'invalid', message }
}

/** `/host [status | restart | stop-all …]`, with stop-all scoped by the CLI's own parser. */
export function parseTuiHostCommand(argumentText: string): TuiHostCommand {
  const [verb, ...rest] = tokenizeTuiHostArguments(argumentText)
  if (!verb || verb === 'status' || verb === 'restart') {
    if (rest.length) return invalid(`/host ${verb ?? 'status'} takes no arguments.`)
    return verb === 'restart' ? { verb: 'restart' } : { verb: 'status' }
  }
  if (verb !== 'stop-all') {
    return invalid(`/host expects status, restart or stop-all, not "${verb}".`)
  }
  if (rest.includes('--json')) return invalid('--json is for taskwraith-host stop-all.')
  if (rest.includes('--sweep')) {
    return invalid(
      '--sweep is not offered here: each stopped Host removes its own records, and taskwraith-host stop-all --sweep clears the rest.'
    )
  }
  try {
    const command = parseHostProductionCli(['stop-all', ...rest])
    if (command.command !== 'stop-all') return invalid('/host stop-all could not be parsed.')
    return { verb: 'stop-all', request: { scope: command.scope, scanArgv: command.scanArgv } }
  } catch (error) {
    if (!(error instanceof HostProductionCliError)) throw error
    // The CLI appends its usage; the lens has its own hint line.
    return invalid(error.message.split(' Usage:')[0].trim())
  }
}

/** `3h 12m`, measured on the Host's own clock. */
export function formatHostUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

/** `sha256:0123456789ab`: enough to tell two builds apart on one line. */
export function shortPayloadVersion(payloadVersion: string): string {
  const match = /^sha256:([0-9a-f]{12})[0-9a-f]*$/.exec(payloadVersion)
  return match ? `sha256:${match[1]}` : payloadVersion
}

function holdersLabel(lifetime: HostStatusProjection['lifetime']): string {
  return lifetime.implicitHolders
    ? `${lifetime.holders} (${lifetime.implicitHolders} implicit)`
    : String(lifetime.holders)
}

const LEGACY_NOTE = ['Host predates leases', '/host restart upgrades it'] as const

/**
 * The segments `/status` adds after `Node Host <connection>`: pid and payload
 * from this connection's discovery record, uptime and holders from the Host's
 * own `host.status`. A value that is not known is left out, never guessed.
 */
export function hostIdentitySegments(input: {
  readonly identity: HostProjectionDiscoveryProcessIdentity | null
  readonly status: HostStatusProjection | null
  readonly lease: TuiHostLeaseState
}): string[] {
  const segments: string[] = []
  const pid = input.identity?.pid ?? input.status?.pid
  if (pid !== undefined) segments.push(`pid ${pid}`)
  if (input.status) {
    segments.push(`up ${formatHostUptime(input.status.uptimeMs)}`)
    segments.push(`holders ${holdersLabel(input.status.lifetime)}`)
  }
  const payload = input.identity?.payloadVersion ?? input.status?.payloadVersion
  if (payload) segments.push(`payload ${shortPayloadVersion(payload)}`)
  // Two segments, so the caller's separator (ASCII under --ascii) joins them.
  if (input.lease === 'legacy') segments.push(...LEGACY_NOTE)
  return segments
}

const STATUS_HINT = 'Esc close · /host restart · /host stop-all [--all | --profile <path>]'

/** `/host status`: everything this TUI knows about the Host it is attached to. */
export function buildHostStatusPanel(input: {
  readonly profilePath: string
  readonly connected: boolean
  readonly identity: HostProjectionDiscoveryProcessIdentity | null
  readonly status: HostStatusProjection | null
  readonly statusError?: string
  readonly lease: TuiHostLeaseState
}): TuiHostPanel {
  const { status } = input
  const fields: TuiHostPanel['fields'][number][] = []
  if (!input.connected)
    fields.push({ label: 'connection', value: 'not connected', tone: 'warning' })
  const pid = input.identity?.pid ?? status?.pid
  if (pid !== undefined) fields.push({ label: 'pid', value: String(pid) })
  if (status) {
    fields.push({ label: 'uptime', value: formatHostUptime(status.uptimeMs) })
    const phase = status.lifetime.phase
    fields.push({
      label: 'lifetime',
      value:
        phase === 'grace' && status.lifetime.graceRemainingMs !== undefined
          ? `grace · exits in ${formatHostUptime(status.lifetime.graceRemainingMs)} unless a client holds it`
          : phase,
      ...(phase === 'held' ? {} : { tone: 'warning' as const })
    })
    fields.push({
      label: 'holders',
      value: `${holdersLabel(status.lifetime)} · ${status.lifetime.declined} declined`
    })
    fields.push({ label: 'live runs', value: String(status.liveWork.runs) })
    if (status.persist) {
      fields.push({ label: 'persist', value: 'on · the last-lease exit is disabled' })
    }
  }
  fields.push({
    label: 'this TUI',
    value:
      input.lease === 'held'
        ? 'holds a lease'
        : input.lease === 'legacy'
          ? LEGACY_NOTE.join(' · ')
          : 'holds no lease',
    tone: input.lease === 'held' ? 'good' : 'warning'
  })
  const payload = input.identity?.payloadVersion ?? status?.payloadVersion
  if (payload) fields.push({ label: 'payload', value: shortPayloadVersion(payload) })
  fields.push({ label: 'profile', value: status?.profilePath ?? input.profilePath })
  for (const client of status?.clients ?? []) {
    const name = client.displayName ?? client.clientId ?? client.clientClass
    fields.push({
      label: 'client',
      value: `${client.clientClass} · ${name} · lease ${client.lease} · ${formatHostUptime(client.connectedForMs)}`
    })
  }
  return {
    title: 'Host',
    fields,
    ...(input.statusError ? { notes: [input.statusError] } : {}),
    hint: STATUS_HINT
  }
}

function scopeLabel(scope: HostStopAllScope): string {
  switch (scope.kind) {
    case 'list':
      return 'none (list only)'
    case 'all':
      return 'every Host (--all)'
    case 'profile':
      return `--profile ${scope.profilePath}`
    case 'payload-root':
      return `--payload-root ${scope.payloadRoot}`
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function hostRow(
  host: HostStopAllHost,
  ownProfile: string,
  outcome?: HostTerminationOutcome
): TuiHostPanelHost {
  const notes: string[] = []
  if (host.profilePath === ownProfile) notes.push('this TUI')
  if (host.source !== 'registry') notes.push(`from ${host.source}`)
  if (outcome) {
    notes.push(outcome.detail ? `${outcome.kind} (${outcome.detail})` : outcome.kind)
    if (outcome.heldBy !== undefined) {
      notes.push(`replacement pid ${outcome.heldBy} was not in the plan and keeps running`)
    }
  } else if (host.liveness !== 'live') {
    notes.push(host.liveness === 'identity_unavailable' ? 'identity unavailable' : host.liveness)
  }
  if (host.note) notes.push(host.note)
  const holders =
    host.holders === null ? 'holders ?' : `holders ${host.holders}+${host.implicitHolders ?? 0}`
  return {
    pid: host.pid === null ? 'pid ?' : `pid ${host.pid}`,
    holders,
    profile: host.profilePath,
    ...(notes.length ? { note: notes.join(' · ') } : {}),
    ...(outcome
      ? {
          tone:
            outcome.heldBy === undefined && HOST_TERMINATION_SUCCESS_KINDS.has(outcome.kind)
              ? ('good' as const)
              : ('error' as const)
        }
      : host.liveness === 'live'
        ? {}
        : { tone: 'warning' as const })
  }
}

/**
 * A stop-all plan. With a scope and something selected, `y` is armed: the
 * prompt names the total, so nothing the viewport cuts off is ever stopped
 * unannounced. Without a scope it is a listing and arms nothing.
 */
export function buildStopAllPlanPanel(plan: TuiHostStopAllPlan, ownProfile: string): TuiHostPanel {
  const listing = plan.request.scope.kind === 'list'
  const fields: TuiHostPanel['fields'][number][] = [
    { label: 'scope', value: scopeLabel(plan.request.scope) },
    { label: 'registry', value: plan.registryRoot }
  ]
  if (plan.request.scanArgv) {
    fields.push({
      label: 'argv scan',
      value: plan.scanUnavailable ? `unavailable (${plan.scanUnavailable})` : 'on'
    })
  }
  const rows = (listing ? plan.hosts : plan.selected).map((host) => hostRow(host, ownProfile))
  const notes: string[] = []
  if (plan.unreadableEntries) {
    notes.push(`${plural(plan.unreadableEntries, 'registry entry')} could not be read.`)
  }
  if (listing) {
    notes.push('Listed only: pass --all, --profile <path> or --payload-root <dir> to stop Hosts.')
    return {
      title: 'Hosts',
      fields,
      hostsHeading: plan.hosts.length
        ? `${plural(plan.hosts.length, 'Host')} found`
        : 'No Hosts found',
      hosts: rows,
      notes,
      hint: 'Esc close'
    }
  }
  const others = plan.hosts.length - plan.selected.length
  if (others) {
    notes.push(
      `${plural(others, 'other Host')} outside this scope ${others === 1 ? 'keeps' : 'keep'} running.`
    )
  }
  if (plan.selected.some((host) => host.profilePath === ownProfile)) {
    notes.push("This TUI's own Host is included; the TUI stays offline until /host restart.")
  }
  if (!plan.selected.length) {
    return {
      title: 'Stop Hosts',
      fields,
      hostsHeading: 'No Host matches this scope',
      hosts: [],
      notes,
      hint: 'Esc close'
    }
  }
  return {
    title: 'Stop Hosts',
    fields,
    hostsHeading: `Stops ${plural(plan.selected.length, 'Host')}`,
    hosts: rows,
    notes,
    prompt: `y stops ${plan.selected.length === 1 ? 'this Host' : `all ${plural(plan.selected.length, 'Host')}`} · any other key cancels`,
    hint: 'Nothing is stopped unless you press y.'
  }
}

/** What a confirmed stop-all did, or why it refused to do anything. */
export function buildStopAllResultPanel(
  outcome: TuiHostStopAllOutcome,
  ownProfile: string
): TuiHostPanel {
  if (outcome.kind === 'registry_changed') {
    return {
      title: 'Stop Hosts',
      fields: [],
      notes: ['The Host registry changed after the list was shown. Nothing was stopped.'],
      hint: 'Run /host stop-all again to see the current Hosts.'
    }
  }
  const stopped = outcome.results.filter(
    (result) =>
      result.outcome.heldBy === undefined && HOST_TERMINATION_SUCCESS_KINDS.has(result.outcome.kind)
  )
  const refused = outcome.results.length - stopped.length
  return {
    title: 'Stop Hosts',
    fields: [],
    hostsHeading: refused
      ? `Stopped ${stopped.length} of ${outcome.results.length}; ${plural(refused, 'Host')} refused`
      : `Stopped ${plural(stopped.length, 'Host')}`,
    hosts: outcome.results.map((result) => hostRow(result.host, ownProfile, result.outcome)),
    ...(refused ? { notes: ['A refused Host keeps running; its row says why.'] } : {}),
    hint: 'Esc close'
  }
}

/** `/host restart` while runs are live: nothing happens without an explicit `y`. */
export function buildRestartConfirmPanel(input: {
  readonly pid: number | null
  readonly profilePath: string
  readonly liveRuns: number | null
  readonly otherHolders?: number | null
}): TuiHostPanel {
  return {
    title: 'Restart Host',
    fields: [
      { label: 'pid', value: input.pid === null ? 'unknown' : String(input.pid) },
      { label: 'profile', value: input.profilePath },
      {
        label: 'live runs',
        value: input.liveRuns === null ? 'unknown' : String(input.liveRuns),
        tone: 'warning'
      },
      ...(input.otherHolders === null || input.otherHolders
        ? [
            {
              label: 'other clients',
              value: input.otherHolders === null ? 'unknown' : String(input.otherHolders),
              tone: 'warning' as const
            }
          ]
        : [])
    ],
    notes: [
      'Restarting stops the Host now; its live runs end with it.',
      ...(input.liveRuns === null || input.otherHolders === null
        ? ['Host status is unavailable; live runs and other clients could not be checked.']
        : []),
      ...(input.otherHolders
        ? [`${plural(input.otherHolders, 'other client')} will be disconnected.`]
        : [])
    ],
    prompt:
      input.liveRuns === null
        ? 'y restarts the Host and may end live runs · any other key cancels'
        : input.liveRuns
          ? `y restarts the Host and ends ${plural(input.liveRuns, 'live run')} · any other key cancels`
          : 'y restarts the Host and disconnects other clients · any other key cancels',
    hint: 'Nothing is restarted unless you press y.'
  }
}
