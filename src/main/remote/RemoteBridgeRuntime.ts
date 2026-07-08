/*
 * RemoteBridgeRuntime — wires the taskwraith-e2ee-v1 transport into the
 * surviving bridge domain layer. Owns the full Mac-side lifecycle:
 *
 *   pairing   `beginPairing()` mints a session id, opens the relay socket
 *             (role mac), and returns the QR bootstrap payload in the exact
 *             `{ ok, bootstrap: { pairingSessionID, bootstrapPayload } }`
 *             shape PairingPage renders. The handshake confirm code surfaces
 *             via `onPairingPrompt` (→ the renderer's
 *             `bridge-pairing-response-received` channel) and trust is held
 *             until `finalizePairing(sessionID, userConfirmed)`.
 *
 *   outbound  Once established, a `BridgeBroadcaster` + `BridgeRunEventSink`
 *             are built with `notify: (m, p) => transport.send(m, p)` — the
 *             projections/run events flow inside encrypted envelopes instead
 *             of the removed Swift daemon. Every (re)establish re-seeds with
 *             `broadcastSnapshot()` (envelopes are idempotent by envelopeId,
 *             so over-sending after a replay-gap is harmless).
 *
 *   inbound   `bridge.requestActionAck` / `bridge.requestPrepareStartTurnAck`
 *             app messages route through the SAME `BridgeActionRouter.route`
 *             policy spine the daemon used (decode → expiry/replay →
 *             allowlist → audit → executor). The audit `pairID` is bound to
 *             the *pinned identity key* — a client-supplied pairID is
 *             overwritten, so a compromised phone can't impersonate another
 *             pairing. Results return as `bridge.ack { requestId, ... }`.
 *
 * Electron-free by construction (everything injected) so the fake-iPhone e2e
 * can drive the real runtime + real relay without booting Electron.
 */

import { createHash, randomUUID } from 'crypto'
import {
  BridgeBroadcaster,
  type BridgeBroadcasterAllowlist,
  type BridgeBroadcasterAppStore,
  type BridgeBroadcasterProjectionSource
} from '../BridgeBroadcaster'
import { makeBridgeRunEventSink } from '../BridgeRunEventSink'
import type { RunEvent, RunEventSink } from '../RunEventBus'
import { E2EE_PROTOCOL, type PairingBootstrapPayload } from '../../shared/e2ee/protocol'
import { b64, exportRawEd25519PublicKey, type KeyPair } from '../../shared/e2ee/keys'
import { signRegisterRequest, type RegisterRequest } from '../../shared/e2ee/resolve'
import { RemoteTransportClient, type TransportSocketFactory } from './RemoteTransportClient'
import type { PersistedRemotePairing } from './RemotePairingStore'

/** Pushed to the renderer's `bridge-pairing-response-received` listener
 * (IncomingPairingPrompt) when the iPhone's clientAuth arrives. */
export interface RemotePairingPrompt {
  sessionID: string
  controllerDisplayName: string
  code: string
}

export interface BeginPairingResult {
  ok: true
  bootstrap: {
    pairingSessionID: string
    bootstrapPayload: PairingBootstrapPayload
  }
}

export interface FinalizePairingResult {
  ok: boolean
  paired?: boolean
  error?: string
}

export interface PairedDeviceSummary {
  iphoneIdentityPubKey: string
  pairId: string
  controllerDisplayName: string
  pairedAt: string
  connected: boolean
}

/** Inbound methods the runtime forwards to the action router. Everything
 * else is rejected (audited surface stays exactly the router's). */
const ROUTABLE_METHODS = new Set(['bridge.requestActionAck', 'bridge.requestPrepareStartTurnAck'])

/** The slice of RemotePairingStore the runtime needs (injectable for tests). */
export interface RemotePairingPersistence {
  list(): PersistedRemotePairing[]
  upsert(pairing: PersistedRemotePairing): void
  remove(iphoneIdentityPubKey: string): boolean
  clear(): void
}

/** POSTs a signed registration to the relay's resolve directory. The default
 * uses global fetch; tests inject a spy. */
export type PostRegistration = (
  registerUrl: string,
  body: RegisterRequest
) => Promise<{ ok: boolean; status: number }>

const defaultPostRegistration: PostRegistration = async (registerUrl, body) => {
  const response = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { ok: response.ok, status: response.status }
}

/** ws://host → http://host (the resolve directory rides the same listener). */
export function relayHttpBase(relayUrl: string): string {
  return relayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '')
}

export function pairIdFromIdentityPubKey(iphoneIdentityPubKey: string): string {
  const raw = b64.decode(iphoneIdentityPubKey)
  return `iphone-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

/** Order-sensitive equality for advertised candidate lists. */
function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export interface RemoteBridgeRuntimeOptions {
  relayUrl: string
  /** The relay URL PHONES should use, when it differs from `relayUrl` (the
   * Mac's own connection). The self-hosted Tailscale shape: the Mac talks
   * to its embedded relay over loopback ws:// while the QR advertises the
   * wss://<dnsName> front door `tailscale serve` puts on the same port —
   * iOS ATS only allows cleartext to local-network hosts, so off-LAN
   * phones need the TLS address. Defaults to `relayUrl`. */
  advertiseRelayUrl?: string
  /** Ordered candidate list for the bootstrap's `relayUrls` (LAN first,
   * wss front door second). Defaults to the single advertised URL. The
   * begin-pairing caller may override per call with the live-probed set. */
  advertiseRelayUrls?: string[]
  /** Shown on the iPhone's pairing sheet ("Pair with <macDisplayName>"). */
  macDisplayName: string
  /** Host OS advertised in the bootstrap — 'mac' | 'windows' | 'linux'. Lets the
   * phone pick a per-OS glyph + host-generic copy. Optional/additive. */
  hostPlatform?: string
  identity: KeyPair
  socketFactory: TransportSocketFactory
  appStore: BridgeBroadcasterAppStore
  allowlist?: BridgeBroadcasterAllowlist
  projectionSource: BridgeBroadcasterProjectionSource
  /** Resolver for legacy chat workspace ids (display-name/path → uuid);
   * forwarded into the BridgeBroadcaster so workspace/thread lists count
   * those chats. See WorkspaceIdentity.ts. */
  canonicalChatWorkspaceId?: (workspaceId: string | null | undefined) => string | null
  remoteProjectionSnapshotThrottleMs?: number | (() => number)
  /** The policy spine — `BridgeActionRouter.route` in production. */
  routeAction: (method: string, params: unknown) => Promise<unknown>
  /** `runEventBus.subscribe` in production; returns the unsubscribe fn. */
  subscribeRunEvents: (sink: RunEventSink) => () => void
  /** Optional host-side interest filter for the bridge run-event sink. */
  runEventFilter?: (event: RunEvent) => boolean
  onPairingPrompt: (prompt: RemotePairingPrompt) => void
  /** Keeps index.ts's `bridgeBroadcaster`/`bridgeBroadcasterRef` (the mutation
   * hooks' nullable refs) in sync with the runtime-owned instance. */
  onBroadcasterChange?: (broadcaster: BridgeBroadcaster | null) => void
  /** Fired on EVERY device establish (incl. re-establish after drops) —
   * unlike onBroadcasterChange, which only fires when the broadcaster is
   * first created. Establish-seeded payloads that aren't part of
   * broadcastSnapshot (e.g. the async provider-model catalogs) hook here,
   * or a phone that reconnects after an app relaunch never receives them. */
  onDeviceEstablished?: () => void
  /** Fired with the LIVE connected-device count (established entries whose
   * transport `isConnected`) — on establish, teardown, and now also when a
   * liveness watchdog marks a silently-dropped phone down (RC6). Consumers that
   * care about who can actually RECEIVE right now (the run-event broadcast
   * filter, the git-snapshot feed) read this. Distinct from paired presence —
   * see `onPairedDeviceCountChange`. Kept as a callback so the runtime stays
   * electron-free. */
  onConnectedDeviceCountChange?: (connectedCount: number) => void
  /** Fired with the PAIRED-with-reconnect-intent count (`established.size`) — on
   * establish and teardown ONLY. The host drives the Electron powerSaveBlocker
   * off this so the Mac stays awake through a phone SUSPEND (a suspended phone is
   * still paired and about to return; RC6's watchdog only moves the live count,
   * never the paired count), and releases it on unpair. Not fired at the
   * persisted-listen add site, so a saved-but-offline pairing never holds power. */
  onPairedDeviceCountChange?: (pairedCount: number) => void
  /** Pairing QR validity window; the un-paired socket is torn down after. */
  pairingWindowMs?: number
  /** Trusted reconnect (T5): persisted pairing + relay resolve registration.
   * Without a store the runtime is QR-pairing-only (T1–T3 behavior). */
  pairingStore?: RemotePairingPersistence
  /** Resolve-directory registration lifetime; refreshed at half-life. */
  registrationTtlMs?: number
  postRegistration?: PostRegistration
  log?: (line: string) => void
}

const DEFAULT_PAIRING_WINDOW_MS = 5 * 60 * 1000
/** Display label for sessions opened by the unauthenticated /v1/beginpair
 * discovery path, distinct from a console QR pairing's device name so the two
 * never alias in the single pending slot. */
const ON_DEMAND_PAIRING_LABEL = 'Discovered device'

interface EstablishedDevice {
  client: RemoteTransportClient
  controllerDisplayName: string
  iphoneIdentityPubKey: string
  registrationTimer: ReturnType<typeof setInterval> | null
}

interface PendingPairing {
  sessionId: string
  client: RemoteTransportClient
  controllerDisplayName: string
  pairingExpiryTimer: ReturnType<typeof setTimeout> | null
  /** The exact bootstrap handed out for this session — re-issued verbatim
   * when the Devices page remounts, so a QR/payload the user already
   * copied or scanned stays alive instead of being silently replaced. */
  bootstrap: NonNullable<BeginPairingResult['bootstrap']>
}

export class RemoteBridgeRuntime {
  private readonly opts: RemoteBridgeRuntimeOptions
  private readonly established = new Map<string, EstablishedDevice>()
  private pending: PendingPairing | null = null
  private broadcaster: BridgeBroadcaster | null = null
  private runSinkUnsub: (() => void) | null = null

  constructor(options: RemoteBridgeRuntimeOptions) {
    this.opts = options
  }

  /** Resume all persisted pairings (trusted reconnect): mint a fresh session
   * per device, pre-pin each phone's identity (no prompt), and register with
   * the resolve directory so each phone can find its own relay room. */
  startListening(): boolean {
    const devices = this.opts.pairingStore?.list() ?? []
    if (devices.length === 0) return false
    for (const device of devices) {
      this.ensurePersistedDeviceListening(device)
    }
    return true
  }

  get hasPersistedPairing(): boolean {
    return (this.opts.pairingStore?.list().length ?? 0) > 0
  }

  listPairedDevices(): PairedDeviceSummary[] {
    const persisted = this.opts.pairingStore?.list() ?? []
    const summaries = new Map<string, PairedDeviceSummary>()
    for (const device of persisted) {
      const established = this.established.get(device.iphoneIdentityPubKey)
      summaries.set(device.iphoneIdentityPubKey, {
        iphoneIdentityPubKey: device.iphoneIdentityPubKey,
        pairId: pairIdFromIdentityPubKey(device.iphoneIdentityPubKey),
        controllerDisplayName: device.controllerDisplayName,
        pairedAt: device.pairedAt,
        connected: established?.client.isConnected ?? false
      })
    }
    return Array.from(summaries.values()).sort((a, b) => a.pairedAt.localeCompare(b.pairedAt))
  }

  /** Forget one paired device (or all when omitted): clear persistence + drop sessions. */
  unpair(iphoneIdentityPubKey?: string): void {
    if (!iphoneIdentityPubKey) {
      this.opts.pairingStore?.clear()
      this.teardownAllEstablished()
      if (!this.pending) {
        this.teardownBroadcaster()
      }
      return
    }
    this.opts.pairingStore?.remove(iphoneIdentityPubKey)
    this.teardownEstablished(iphoneIdentityPubKey)
    if (this.established.size === 0 && !this.pending) {
      this.teardownBroadcaster()
    }
  }

  /** Read-only self-description for QR-optional discovery (served at GET
   * /v1/hostinfo). Carries the SAME public identity + relay material a pairing
   * bootstrap advertises — minus the per-session `sessionId`/`expiresAt` — so
   * another tailnet peer's "oracle" host can learn this machine runs TaskWraith
   * and fetch its identity pubkey + phone-reachable relay URLs. Nothing here is
   * secret (trust is still the 6-digit SAS); deriving the pubkey + relayUrls the
   * exact same way `beginPairing` does keeps the advertisement from drifting from
   * the bootstrap. Pure read — never mints a session. */
  describeHost(): {
    protocol: string
    macIdentityPubKey: string
    macDisplayName: string
    hostPlatform?: string
    relayUrls: string[]
  } {
    return {
      protocol: E2EE_PROTOCOL,
      macIdentityPubKey: b64.encode(exportRawEd25519PublicKey(this.opts.identity.publicKey)),
      macDisplayName: this.opts.macDisplayName,
      hostPlatform: this.opts.hostPlatform,
      relayUrls: this.resolveAdvertiseRelayUrls()
    }
  }

  /** Mint a pairing session + QR bootstrap — or RE-ISSUE the live one.
   *
   * Every call used to tear down the in-flight session, so merely
   * remounting the Devices page (tab away and back) silently killed the
   * QR/payload the user had on screen or in their clipboard — pairing
   * then failed with no listener on the old session. A still-valid
   * pending session (same label, >30s of window left, no handshake
   * concluded) is now returned verbatim; pass `force` (the Refresh QR
   * button) to deliberately mint a new one. Established devices are
   * never touched either way. */
  beginPairing(
    controllerDisplayName?: string,
    options?: { force?: boolean; advertiseRelayUrls?: string[] }
  ): BeginPairingResult {
    const controllerDisplayNameTrimmed = controllerDisplayName?.trim() || 'iOS device'
    const advertiseRelayUrls = this.resolveAdvertiseRelayUrls(options?.advertiseRelayUrls)
    if (
      !options?.force &&
      this.pending &&
      this.pending.controllerDisplayName === controllerDisplayNameTrimmed &&
      this.pending.bootstrap.bootstrapPayload.expiresAt > Date.now() + 30_000 &&
      !this.pending.client.trustedPeerIdentityRaw() &&
      // The reachable-candidate set can change between clicks (front door
      // healed / died) — a cached bootstrap with a stale list must not be
      // reused, or the QR re-advertises a door we just probed dead.
      sameStringList(this.pending.bootstrap.bootstrapPayload.relayUrls ?? [], advertiseRelayUrls)
    ) {
      return { ok: true, bootstrap: this.pending.bootstrap }
    }
    this.teardownPending()
    const sessionId = randomUUID()
    const windowMs = this.opts.pairingWindowMs ?? DEFAULT_PAIRING_WINDOW_MS

    const client = this.createClient({
      onConfirmCode: (sessionID, code) =>
        this.opts.onPairingPrompt({
          sessionID,
          controllerDisplayName: controllerDisplayNameTrimmed,
          code
        }),
      onEstablished: () => this.onDeviceEstablished()
    })
    client.beginSession(this.opts.relayUrl, sessionId)

    const pairingExpiryTimer = setTimeout(() => {
      if (
        this.pending?.sessionId === sessionId &&
        !client.isConnected &&
        !client.trustedPeerIdentityRaw()
      ) {
        this.opts.log?.('[remote-bridge] pairing window expired — closing session')
        this.teardownPending()
      }
    }, windowMs)
    pairingExpiryTimer.unref?.()

    const bootstrap: NonNullable<BeginPairingResult['bootstrap']> = {
      pairingSessionID: sessionId,
      bootstrapPayload: {
        v: 1,
        protocol: E2EE_PROTOCOL,
        // Phones use the advertised URL (TLS front door in the
        // self-hosted Tailscale shape); the Mac keeps `relayUrl`. The v1
        // single field prefers the wss front door (works from anywhere
        // with Tailscale) so old clients keep today's behavior; new
        // clients walk `relayUrls` LAN-first.
        relayUrl:
          advertiseRelayUrls.find((url) => url.startsWith('wss:')) ??
          advertiseRelayUrls[0] ??
          this.opts.advertiseRelayUrl ??
          this.opts.relayUrl,
        relayUrls: advertiseRelayUrls,
        sessionId,
        macIdentityPubKey: b64.encode(client.macIdentityRaw()),
        macDisplayName: this.opts.macDisplayName,
        hostPlatform: this.opts.hostPlatform,
        expiresAt: Date.now() + windowMs
      }
    }

    this.pending = {
      sessionId,
      client,
      controllerDisplayName: controllerDisplayNameTrimmed,
      pairingExpiryTimer,
      bootstrap
    }

    return { ok: true, bootstrap }
  }

  /** beginPairing for the UNAUTHENTICATED /v1/beginpair discovery path. Unlike
   * the console QR (`beginPairing`), an anonymous tailnet POST must NEVER evict
   * a pairing the user started at the desktop, or one already mid-handshake — it
   * may only use a FREE slot. A still-valid on-demand session is re-issued
   * verbatim (idempotent retries — so a flood of POSTs can't churn relay
   * sockets: only the first, slot-free POST mints one). A busy slot returns null
   * (relay → 503) and the discovered phone retries once it frees. The console QR
   * path can still evict an on-demand session (its `beginPairing` tears down any
   * pending) — the asymmetry is deliberate: a human at the desktop outranks an
   * anonymous POST. */
  beginPairingOnDemand(): BeginPairingResult | null {
    const p = this.pending
    if (p) {
      const live = p.client.trustedPeerIdentityRaw() != null || p.client.isConnected
      const fresh = p.bootstrap.bootstrapPayload.expiresAt > Date.now()
      // Our own still-valid on-demand session → re-issue (idempotent retry).
      if (!live && fresh && p.controllerDisplayName === ON_DEMAND_PAIRING_LABEL) {
        return { ok: true, bootstrap: p.bootstrap }
      }
      // A live or still-windowed session belongs to someone else (the console
      // QR, or a handshake in progress) — refuse rather than tear it down.
      if (live || fresh) return null
    }
    return this.beginPairing(ON_DEMAND_PAIRING_LABEL, { force: true })
  }

  /** The candidate list a fresh bootstrap advertises: per-call override
   * (the live-probed set) → static opts list → the single legacy URL. */
  private resolveAdvertiseRelayUrls(override?: string[]): string[] {
    const clean = (urls?: string[]): string[] => [
      ...new Set((urls ?? []).map((url) => url.trim()).filter(Boolean))
    ]
    const fromOverride = clean(override)
    if (fromOverride.length > 0) return fromOverride
    const fromOpts = clean(this.opts.advertiseRelayUrls)
    if (fromOpts.length > 0) return fromOpts
    return [this.opts.advertiseRelayUrl ?? this.opts.relayUrl]
  }

  /** Resolve the held trust decision for the prompt the user just answered. */
  finalizePairing(sessionID: string, userConfirmed: boolean): FinalizePairingResult {
    if (!this.pending || this.pending.sessionId !== sessionID) {
      return { ok: false, error: 'Pairing session is no longer active.' }
    }
    const pending = this.pending
    pending.client.finalizePairing(userConfirmed)
    if (!userConfirmed) {
      this.teardownPending()
      this.startListening()
      return { ok: true, paired: false }
    }
    const peerRaw = pending.client.trustedPeerIdentityRaw()
    if (!peerRaw) {
      this.teardownPending()
      return { ok: false, error: 'Pairing did not produce a trusted device identity.' }
    }
    const iphoneIdentityPubKey = b64.encode(peerRaw)
    if (pending.pairingExpiryTimer) {
      clearTimeout(pending.pairingExpiryTimer)
      pending.pairingExpiryTimer = null
    }
    this.pending = null
    this.promoteToEstablished({
      iphoneIdentityPubKey,
      controllerDisplayName: pending.controllerDisplayName,
      client: pending.client
    })
    this.opts.pairingStore?.upsert({
      v: 1,
      iphoneIdentityPubKey,
      controllerDisplayName: pending.controllerDisplayName,
      pairedAt: new Date().toISOString()
    })
    this.startRegistrationRefresh(iphoneIdentityPubKey)
    return { ok: true, paired: true }
  }

  get isEstablished(): boolean {
    for (const device of this.established.values()) {
      if (device.client.isConnected) return true
    }
    return false
  }

  dispose(): void {
    this.teardownPending()
    this.teardownAllEstablished()
    this.teardownBroadcaster()
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private createClient(overrides: {
    iphoneIdentityPubKey?: string
    pinnedPeerIdentityRaw?: Buffer
    onConfirmCode?: (sessionId: string, code: string) => void
    onEstablished?: () => void
  }): RemoteTransportClient {
    const knownPubKey = overrides.iphoneIdentityPubKey
    const clientRef: { current?: RemoteTransportClient } = {}
    const client = new RemoteTransportClient({
      identityKeyPair: this.opts.identity,
      socketFactory: this.opts.socketFactory,
      pinnedPeerIdentityRaw: overrides.pinnedPeerIdentityRaw,
      onConfirmCode: overrides.onConfirmCode,
      onMessage: (method, params) => {
        const pubKey =
          knownPubKey ??
          (() => {
            const raw = clientRef.current?.trustedPeerIdentityRaw()
            return raw ? b64.encode(raw) : null
          })()
        void this.handleInbound(pubKey, method, params)
      },
      onEstablished: () => {
        overrides.onEstablished?.()
      },
      onConnectionChange: (connected) => {
        this.opts.log?.(
          `[remote-bridge] transport ${connected ? 'established' : 'down'} (${knownPubKey ?? 'pending'})`
        )
        // RC6: a watchdog-driven mark-down (or a clean close) recomputes the LIVE
        // count so the run-event filter / git feed stop treating a gone phone as
        // present. On a fresh-pairing establish this may transiently compute 0
        // before promoteToEstablished adds the entry, then onDeviceEstablished
        // re-publishes 1 synchronously — benign (no async yield between them).
        this.publishConnectedDeviceCount()
      },
      onReplayGap: () => {
        // RC5: same pubKey resolution as onMessage. A same-epoch resume evicted
        // un-acked tail — push a targeted full snapshot so the returning peer
        // recovers any one-shot it missed.
        const pubKey =
          knownPubKey ??
          (() => {
            const raw = clientRef.current?.trustedPeerIdentityRaw()
            return raw ? b64.encode(raw) : null
          })()
        this.resyncDeviceOnReplayGap(pubKey)
      },
      log: this.opts.log
    })
    clientRef.current = client
    return client
  }

  /** RC5: on a detected replay-buffer gap, re-push the current projection to
   * EXACTLY the affected device via Slice 1's targeted `emitSnapshotTo` (never a
   * broadcast, never resetThrottle). Idempotent by envelopeId, so it composes
   * safely with the phone's own Slice-2 pull. No teardown, no reconnect. */
  private resyncDeviceOnReplayGap(iphoneIdentityPubKey: string | null): void {
    if (!iphoneIdentityPubKey) return
    const device = this.established.get(iphoneIdentityPubKey)
    if (!device || !this.broadcaster) return
    this.broadcaster.emitSnapshotTo((method, params) => device.client.send(method, params))
    this.opts.log?.(
      `[remote-bridge] replay gap → targeted resync (${pairIdFromIdentityPubKey(iphoneIdentityPubKey)})`
    )
  }

  private promoteToEstablished(args: {
    iphoneIdentityPubKey: string
    controllerDisplayName: string
    client: RemoteTransportClient
  }): void {
    const existing = this.established.get(args.iphoneIdentityPubKey)
    if (existing && existing.client !== args.client) {
      this.stopRegistrationRefresh(existing)
      existing.client.dispose()
    }
    this.established.set(args.iphoneIdentityPubKey, {
      client: args.client,
      controllerDisplayName: args.controllerDisplayName,
      iphoneIdentityPubKey: args.iphoneIdentityPubKey,
      registrationTimer: existing?.registrationTimer ?? null
    })
    if (args.client.isConnected) {
      this.onDeviceEstablished()
    }
  }

  private ensurePersistedDeviceListening(device: PersistedRemotePairing): void {
    if (this.established.has(device.iphoneIdentityPubKey)) return
    const client = this.createClient({
      iphoneIdentityPubKey: device.iphoneIdentityPubKey,
      pinnedPeerIdentityRaw: b64.decode(device.iphoneIdentityPubKey),
      onEstablished: () => this.onDeviceEstablished()
    })
    const sessionId = randomUUID()
    client.beginSession(this.opts.relayUrl, sessionId)
    this.established.set(device.iphoneIdentityPubKey, {
      client,
      controllerDisplayName: device.controllerDisplayName,
      iphoneIdentityPubKey: device.iphoneIdentityPubKey,
      registrationTimer: null
    })
    this.startRegistrationRefresh(device.iphoneIdentityPubKey)
  }

  /** Register (and keep registering at half-life) the current session with
   * the relay's resolve directory. Fire-and-forget: a failed registration
   * only degrades cold reconnect, never the live channel. */
  private startRegistrationRefresh(iphoneIdentityPubKey: string): void {
    const device = this.established.get(iphoneIdentityPubKey)
    if (!device) return
    this.stopRegistrationRefresh(device)
    const ttlMs = this.opts.registrationTtlMs ?? 60 * 60 * 1000
    const post = (): void => {
      const sessionId = device.client.currentSessionId
      if (!sessionId) return
      const request = signRegisterRequest(this.opts.identity, {
        sessionId,
        allowedPeers: [iphoneIdentityPubKey],
        issuedAt: Date.now(),
        ttlMs
      })
      const postRegistration = this.opts.postRegistration ?? defaultPostRegistration
      void postRegistration(`${relayHttpBase(this.opts.relayUrl)}/v1/resolve/register`, request)
        .then((result) => {
          if (!result.ok) {
            this.opts.log?.(`[remote-bridge] resolve registration failed (${result.status})`)
          }
        })
        .catch((err: unknown) => {
          this.opts.log?.(
            `[remote-bridge] resolve registration error: ${err instanceof Error ? err.message : String(err)}`
          )
        })
    }
    post()
    device.registrationTimer = setInterval(post, Math.max(10_000, Math.floor(ttlMs / 2)))
    device.registrationTimer.unref?.()
  }

  private stopRegistrationRefresh(device: EstablishedDevice): void {
    if (device.registrationTimer) {
      clearInterval(device.registrationTimer)
      device.registrationTimer = null
    }
  }

  private broadcast(method: string, params?: unknown): void {
    for (const device of this.established.values()) {
      device.client.send(method, params)
    }
  }

  /** RC6: count of established devices whose transport is actually connected
   * right now (a silently-dropped or suspended phone stays in `established` but
   * flips isConnected=false). */
  private connectedDeviceCount(): number {
    let n = 0
    for (const device of this.established.values()) {
      if (device.client.isConnected) n += 1
    }
    return n
  }

  private publishConnectedDeviceCount(): void {
    this.opts.onConnectedDeviceCountChange?.(this.connectedDeviceCount())
  }

  private publishPairedDeviceCount(): void {
    this.opts.onPairedDeviceCountChange?.(this.established.size)
  }

  private onDeviceEstablished(): void {
    if (!this.broadcaster) {
      this.broadcaster = new BridgeBroadcaster({
        daemon: { notify: (method, params) => this.broadcast(method, params) },
        appStore: this.opts.appStore,
        allowlist: this.opts.allowlist,
        projectionSource: this.opts.projectionSource,
        canonicalChatWorkspaceId: this.opts.canonicalChatWorkspaceId,
        remoteProjectionSnapshotThrottleMs: this.opts.remoteProjectionSnapshotThrottleMs,
        log: this.opts.log
      })
      this.opts.onBroadcasterChange?.(this.broadcaster)
    }
    if (!this.runSinkUnsub) {
      this.runSinkUnsub = this.opts.subscribeRunEvents(
        makeBridgeRunEventSink({
          notifier: { notify: (method, params) => this.broadcast(method, params) },
          filter: this.opts.runEventFilter,
          log: this.opts.log
        })
      )
    }
    this.broadcaster.broadcastSnapshot()
    this.opts.onDeviceEstablished?.()
    // Live count for the run-event filter / git feed; paired count for the
    // powerSaveBlocker (this device is genuinely connected now).
    this.publishConnectedDeviceCount()
    this.publishPairedDeviceCount()
  }

  private async handleInbound(
    iphoneIdentityPubKey: string | null,
    method: string,
    params: unknown
  ): Promise<void> {
    const dict = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
    const requestId = typeof dict.requestId === 'string' ? dict.requestId : null
    if (!ROUTABLE_METHODS.has(method)) {
      this.opts.log?.(`[remote-bridge] dropped unsupported inbound method "${method}"`)
      if (requestId) {
        this.sendToDevice(iphoneIdentityPubKey, 'bridge.ack', {
          requestId,
          method,
          ok: false,
          error: `Unsupported method "${method}"`
        })
      }
      return
    }
    const pairID = iphoneIdentityPubKey ? pairIdFromIdentityPubKey(iphoneIdentityPubKey) : null
    if (!pairID) {
      this.opts.log?.(`[remote-bridge] dropped "${method}" — no trusted pairing`)
      return
    }
    try {
      // requestingDeviceKey is the AUTHENTICATED pinned identity (same source
      // as pairID), spread LAST so a client-supplied value in `dict` cannot
      // override it. Read-only device-targeted actions (fullProjectionResync)
      // use it to re-push to exactly this device.
      const result = await this.opts.routeAction(method, {
        ...dict,
        pairID,
        requestingDeviceKey: iphoneIdentityPubKey
      })
      this.sendToDevice(iphoneIdentityPubKey, 'bridge.ack', { requestId, method, ok: true, result })
    } catch (err) {
      this.sendToDevice(iphoneIdentityPubKey, 'bridge.ack', {
        requestId,
        method,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private sendToDevice(
    iphoneIdentityPubKey: string | null,
    method: string,
    params?: unknown
  ): void {
    if (!iphoneIdentityPubKey) return
    this.established.get(iphoneIdentityPubKey)?.client.send(method, params)
  }

  /** Slice 1 (RC1/RC2): re-push the current visible projection to EXACTLY one
   * requesting device — never a broadcast, never resetThrottle. Synchronous, so
   * the snapshot frames enqueue on the device's session ahead of the action ack
   * (the phone applies the snapshot before it applies the ack). Read-only; the
   * emitted frames are the SAME the periodic broadcast produces, so no data
   * surface is widened. Invoked by the fullProjectionResyncFn executor dep. */
  resyncProjectionToDevice(iphoneIdentityPubKey: string): {
    ok: boolean
    sentEnvelopes?: number
    reason?: string
  } {
    const device = this.established.get(iphoneIdentityPubKey)
    if (!device || !device.client.isConnected) {
      return { ok: false, reason: 'device not connected' }
    }
    if (!this.broadcaster) {
      return { ok: false, reason: 'no broadcaster' }
    }
    const { sentEnvelopes } = this.broadcaster.emitSnapshotTo((method, params) =>
      device.client.send(method, params)
    )
    return { ok: true, sentEnvelopes }
  }

  private teardownPending(): void {
    if (!this.pending) return
    if (this.pending.pairingExpiryTimer) {
      clearTimeout(this.pending.pairingExpiryTimer)
    }
    this.pending.client.dispose()
    this.pending = null
  }

  private teardownEstablished(iphoneIdentityPubKey: string): void {
    const device = this.established.get(iphoneIdentityPubKey)
    if (!device) return
    this.stopRegistrationRefresh(device)
    device.client.dispose()
    this.established.delete(iphoneIdentityPubKey)
    // Post-delete: recompute the live count AND the paired count — the last
    // unpair drops paired to 0 and releases the powerSaveBlocker exactly as before.
    this.publishConnectedDeviceCount()
    this.publishPairedDeviceCount()
  }

  private teardownAllEstablished(): void {
    for (const key of [...this.established.keys()]) {
      this.teardownEstablished(key)
    }
  }

  private teardownBroadcaster(): void {
    this.runSinkUnsub?.()
    this.runSinkUnsub = null
    if (this.broadcaster) {
      this.broadcaster = null
      this.opts.onBroadcasterChange?.(null)
    }
  }
}
