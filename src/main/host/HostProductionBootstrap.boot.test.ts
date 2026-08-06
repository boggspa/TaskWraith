/**
 * Wave 4.4 — PRODUCTION BOOT PROOF.
 *
 * THIS FILE EXISTS BECAUSE OF ONE OMISSION, AND THE OMISSION IS THE POINT.
 *
 * `createHostProductionBootstrap` accepts an OPTIONAL `createComposition` seam
 * that defaults to the real `createHostMainComposition`. Every test in
 * `HostProductionBootstrap.test.ts` injects `createComposition: () =>
 * fakeComposition()` and `createServer: () => fakeServer()`. Those are correct
 * for what that file proves — assembly, re-entrancy, teardown — but the
 * consequence is that THE REAL COMPOSITION AND THE REAL LOCAL SERVER HAVE
 * NEVER BEEN BOOTED BY ANY TEST.
 *
 * So the arc has been shipping a Host that was never observed to start, serve,
 * or stop. This file omits BOTH seams and boots the real thing. The only fakes
 * are `chatList` and `bridge`, which are genuinely external boundaries
 * (AppStore / BridgeActionExecutor) rather than parts of the Host transport
 * path. Everything between the supervisor and the socket is real.
 *
 * SEAT REQUIREMENT: this suite performs a real unix-domain socket listen.
 * Sandboxed seats that return EPERM on `listen()` cannot run it. That limit is
 * seat-specific, not environmental.
 *
 * SAFETY: every test uses a fresh `fs.mkdtemp` directory. It must NEVER use a
 * real userData path — a live TaskWraith app would collide with it, and the
 * teardown assertions delete Host artifacts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  decodeTaskWraithHostDiscovery,
  taskWraithHostDiscoveryPath,
  taskWraithHostTokenPath
} from '../../shared/taskWraithHostPaths.node'

import { HostProjectionClient } from './HostProjectionClient'
import {
  createHostProductionBootstrap,
  type HostProductionBootstrapOptions
} from './HostProductionBootstrap'
import type { HostSupervisor } from './HostSupervisor'

const HOST_ID = 'boot-proof-host-0001'
const HOST_VERSION = '0.0.0-boot-proof'

let userDataPath: string
let supervisor: HostSupervisor | null = null
let client: HostProjectionClient | null = null

/** Genuinely external boundary — not part of the Host transport path. */
function externalChatList(): HostProductionBootstrapOptions['chatList'] {
  return { getChatList: vi.fn().mockReturnValue([]) }
}

/** Genuinely external boundary — not part of the Host transport path. */
function externalBridge(): HostProductionBootstrapOptions['bridge'] {
  const ok = async (): Promise<{ executed: boolean }> => ({ executed: true })
  return {
    executeComposerPrompt: ok,
    executeEnsembleSteer: ok,
    executeCancelRun: ok,
    executeEnsembleCancelRound: ok,
    executeApprovalReply: ok,
    executeQuestionReply: ok,
    executeQuestionReject: ok,
    executeEnsembleRosterUpdate: ok,
    executeSetWatchedThread: ok
  } as unknown as HostProductionBootstrapOptions['bridge']
}

/**
 * NOTE THE ABSENCES. `createComposition` and `createServer` are deliberately
 * NOT provided, so the production defaults run. Adding either one back turns
 * this suite into a restatement of the existing fake-driven tests.
 */
function productionOptions(): HostProductionBootstrapOptions {
  return {
    userDataPath,
    chatList: externalChatList(),
    bridge: externalBridge(),
    host: { hostId: HOST_ID, hostVersion: HOST_VERSION }
  }
}

function readOnlyClient(): HostProjectionClient {
  return new HostProjectionClient({
    client: {
      clientId: 'wave-44-boot-proof',
      clientClass: 'desktop',
      clientVersion: HOST_VERSION
    },
    capabilities: ['bootstrap', 'snapshot', 'health'],
    userDataPath,
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 5_000
  })
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'tw-host-boot-proof-'))
  supervisor = null
  client = null
})

afterEach(() => {
  // Teardown must survive a failed assertion mid-test, or one red test leaves a
  // live listener that hangs the whole suite.
  try {
    client?.close()
  } catch {
    /* client already closed */
  }
  try {
    supervisor?.stopSync()
  } catch {
    /* supervisor already stopped or never started */
  }
  rmSync(userDataPath, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/*  1. BOOT                                                            */
/* ------------------------------------------------------------------ */

describe('Wave 4.4 boot — the real composition actually starts', () => {
  it('starts the REAL composition and publishes a decodable discovery record', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    const discoveryPath = taskWraithHostDiscoveryPath(userDataPath)
    expect(existsSync(discoveryPath)).toBe(true)

    // Existence alone is not evidence — a stale artifact also exists. Decode it
    // through the SHIPPING fail-closed decoder, so this asserts the record a
    // real client would actually accept rather than a shape invented here.
    const decoded = decodeTaskWraithHostDiscovery(JSON.parse(readFileSync(discoveryPath, 'utf8')))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return

    expect(decoded.discovery.protocolVersion).toBe(2)
    expect(decoded.discovery.pid).toBe(process.pid)
    expect(decoded.discovery.startedAt.length).toBeGreaterThan(0)

    // The socket and token it advertises must really be there. A discovery
    // record pointing at nothing is worse than no record: a client would trust
    // it and then fail obscurely.
    expect(existsSync(decoded.discovery.socketPath)).toBe(true)
    expect(existsSync(decoded.discovery.tokenPath)).toBe(true)
    expect(decoded.discovery.tokenPath).toBe(taskWraithHostTokenPath(userDataPath))
  }, 20_000)

  it('reports itself running after a real start', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    expect(supervisor.isRunning).toBe(true)
    expect(supervisor.isStopped).toBe(false)
  }, 20_000)
})

/* ------------------------------------------------------------------ */
/*  2. SERVE                                                           */
/* ------------------------------------------------------------------ */

describe('Wave 4.4 serve — a real client completes a real authenticated round trip', () => {
  it('accepts a REAL client over the REAL socket and returns a REAL snapshot', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    // No injected transport anywhere in this test. The client reads the
    // discovery file, reads the token, opens the unix socket, and performs the
    // authenticated bootstrap handshake exactly as Desktop and TUI do.
    client = readOnlyClient()
    const welcome = await client.connect()

    // The identity we injected at bootstrap must be the identity the wire
    // advertises. This is the assertion that proves the hostId resolved by
    // HostInstallIdentity actually reaches a connecting client.
    expect(welcome.hostId).toBe(HOST_ID)
    expect(welcome.hostVersion).toBe(HOST_VERSION)
    expect(welcome.protocolVersion).toBe(2)
    expect(welcome.sessionId.length).toBeGreaterThan(0)

    const frame = await client.getSnapshot()

    // A real HostSnapshot over the real wire — the first in the arc.
    //
    // NOTE, because it is easy to assert wrongly here: HostSnapshot carries NO
    // hostId. Identity is a BOOTSTRAP concern, established once in the welcome
    // above and not restated on every snapshot. So the identity assertion
    // belongs on `welcome.hostId`, and what a snapshot must prove instead is
    // that it is a real bounded projection rather than a stub.
    expect(frame.snapshot).toBeDefined()
    expect(frame.snapshot.protocolVersion).toBe(2)
    expect(typeof frame.snapshot.generation).toBe('number')
    expect(typeof frame.snapshot.cursor).toBe('number')
    expect(frame.snapshot.generatedAt.length).toBeGreaterThan(0)
    expect(frame.snapshot.health).toBeDefined()

    // Every projection family must be present as an array. Empty is correct
    // here (the injected chatList is empty) — but ABSENT would mean the wire
    // dropped a family, which a client would read as "there is nothing here".
    for (const family of [
      frame.snapshot.workspaces,
      frame.snapshot.threads,
      frame.snapshot.runs,
      frame.snapshot.approvals,
      frame.snapshot.warnings
    ]) {
      expect(Array.isArray(family)).toBe(true)
    }
  }, 20_000)

  it('negotiates only the capabilities it asked for', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    client = readOnlyClient()
    const welcome = await client.connect()

    // Host intersects its offer with the request. A read-only client must not
    // come back holding command/receipt authority it never asked for.
    expect(welcome.capabilities).not.toContain('commands')
    expect(welcome.capabilities).not.toContain('receipts')
  }, 20_000)
})

/* ------------------------------------------------------------------ */
/*  3. STOP                                                            */
/* ------------------------------------------------------------------ */

describe('Wave 4.4 stop — explicit stop is real, not cosmetic', () => {
  it('removes its discovery artifacts on stopSync', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    const discoveryPath = taskWraithHostDiscoveryPath(userDataPath)
    expect(existsSync(discoveryPath)).toBe(true)

    supervisor.stopSync()

    // A Host that claims to stop but leaves a discovery record behind will be
    // found by the next client, which then hangs against a dead socket.
    expect(existsSync(discoveryPath)).toBe(false)
    expect(supervisor.isStopped).toBe(true)
    expect(supervisor.isRunning).toBe(false)
  }, 20_000)

  it('REFUSES a fresh connection after stop', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    // Prove the socket was genuinely live first, so the refusal below cannot be
    // explained by a Host that never served at all.
    const before = readOnlyClient()
    await before.connect()
    before.close()

    supervisor.stopSync()

    // This is the assertion that separates "stopped" from "claims to be
    // stopped". A listener still accepting connections after an explicit stop
    // is an undeclared background service, which the goal forbids outright.
    client = readOnlyClient()
    await expect(client.connect()).rejects.toThrow()
  }, 25_000)
})
