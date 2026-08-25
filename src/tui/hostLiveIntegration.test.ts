/**
 * Wave 4.6 — THE TUI AGAINST A REAL HOST.
 *
 * Every TUI test to date drives a TCP Fake Host. This is the first time any
 * client actually talks to the lease-owned production Node Host over a real
 * authenticated Unix socket or Windows named pipe.
 *
 * The production factory, domain store, identity, authority lease, local
 * server, and TUI projection client are all real. Only terminal I/O is fake.
 *
 * SEAT REQUIREMENT: this suite performs a real local-socket listen (a Unix
 * domain socket or Windows named pipe). Sandboxed seats that return EPERM on
 * `listen()` cannot run it.
 *
 * SAFETY: every test uses `fs.mkdtemp` ONLY. It must NEVER use a real userData
 * profile — a live TaskWraith app would collide with it. Zero stray sockets or
 * temp dirs remain after the suite completes.
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ReadStream, WriteStream } from 'node:tty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHostNodeProductionServer } from '../host-node/HostNodeProductionFactory'
import type { HostNodeProductionServer } from '../host-node/HostNodeProductionServer'
import { HOST_SERVER_PRODUCTION_VERSION } from '../host-runtime/HostServerIdentity'
import { HostProjectionClient } from '../host-client/HostProjectionClient'
import type { HostCapability } from '../shared/hostProtocol'
import {
  taskWraithHostAuthorityLeasePath,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { stripAnsi } from './ansi'
import { TaskWraithTui } from './TaskWraithTui'

const PRODUCTION_CAPABILITY_FLOOR: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'provider-catalog',
  'provider-auth',
  'history',
  'setup',
  'host-lifecycle',
  'commands',
  'receipts',
  'health'
]

/* -------------------------------------------------------------------------
 * Fake TTY streams — mirrors the pattern from TaskWraithTui.test.ts
 * ---------------------------------------------------------------------- */

class FakeInput extends PassThrough {
  isTTY = true as const
  private rawMode = false
  setRawMode(mode: boolean): this {
    this.rawMode = mode
    return this
  }
  get isRawMode(): boolean {
    return this.rawMode
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true as const
  columns = 80
  rows = 24
  readonly frames: string[] = []
  write(chunk: string): boolean {
    this.frames.push(chunk)
    return true
  }
  get lastFrame(): string {
    return stripAnsi(this.frames.at(-1) ?? '')
  }
}

function makeTty(): { input: FakeInput; output: FakeOutput } {
  return { input: new FakeInput(), output: new FakeOutput() }
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeoutMs = 5_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

/* -------------------------------------------------------------------------
 * Suite lifecycle
 * ---------------------------------------------------------------------- */

let userDataPath: string
let profileParent: string
let server: HostNodeProductionServer | null = null
let serverStarted = false
let tui: TaskWraithTui | null = null

beforeEach(() => {
  profileParent = realpathSync(mkdtempSync(join(tmpdir(), 'tw-tui-live-host-')))
  userDataPath = join(profileParent, 'profile')
  server = null
  serverStarted = false
  tui = null
})

afterEach(async () => {
  // Teardown must survive a failed assertion mid-test, or one red test leaves a
  // live listener that hangs the suite.
  try {
    tui?.stop()
  } catch {
    /* tui already stopped or never started */
  }
  try {
    if (serverStarted) await server?.stop()
  } catch {
    /* server already stopped or never started */
  }
  rmSync(profileParent, { recursive: true, force: true })
})

async function startProductionHost(): Promise<HostNodeProductionServer> {
  const started = createHostNodeProductionServer({
    profilePath: userDataPath,
    // A deterministic absent explicit binary keeps this socket test independent
    // of any developer-installed Muse executable or credentials.
    museBinary: join(profileParent, 'missing-muse-binary'),
    temporaryParent: profileParent
  })
  await started.start()
  server = started
  serverStarted = true
  return started
}

async function assertProductionWelcome(): Promise<void> {
  const client = new HostProjectionClient({
    userDataPath,
    client: {
      clientId: 'tui-live-integration-probe',
      clientClass: 'test',
      clientVersion: 'tui-live-integration'
    },
    capabilities: PRODUCTION_CAPABILITY_FLOOR
  })
  try {
    const welcome = await client.connect()
    expect(welcome.hostVersion).toBe(HOST_SERVER_PRODUCTION_VERSION)
    expect(welcome.capabilities).toEqual(expect.arrayContaining([...PRODUCTION_CAPABILITY_FLOOR]))
    expect((await client.getSnapshot()).snapshot).toMatchObject({ workspaces: [], threads: [] })
  } finally {
    client.close()
  }
}

function expectOwnedHostArtifactsReleased(): void {
  expect(existsSync(taskWraithHostDiscoveryPath(userDataPath))).toBe(false)
  expect(existsSync(taskWraithHostTokenPath(userDataPath))).toBe(false)
  expect(existsSync(taskWraithHostAuthorityLeasePath(userDataPath))).toBe(false)
  if (process.platform !== 'win32') {
    expect(existsSync(taskWraithHostSocketPath(userDataPath))).toBe(false)
  }
  expect(existsSync(join(userDataPath, 'host-runtime', 'host-install-identity.json'))).toBe(true)
}

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

describe('Wave 4.6 — TUI against a real Host', () => {
  it('connects to a real production Node Host over a real local socket and renders a live snapshot', async () => {
    await startProductionHost()
    await assertProductionWelcome()

    const { input, output } = makeTty()
    tui = new TaskWraithTui({
      clientVersion: 'tui-live-integration',
      userDataPath,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })

    await tui.start()

    // After start() resolves, the TUI has connected and retrieved a snapshot
    // from a real production Node Host over a real local socket — the first time any client has
    // done this in the arc.
    //
    // The welcome handler sets a notice "Connected to TaskWraith Host" (1.5s),
    // and renderHud paints a durable "CONNECTED" in the footer bar whenever
    // state.connection is 'connected' and no thread is selected. This test
    // catches either form: the transient notice if the poll lands early, or
    // the durable HUD token after the notice expires. Neither exists if the
    // connection failed — a failed connect lands in "connecting" / "offline" /
    // "incompatible".
    expect(output.frames.length).toBeGreaterThan(0)

    // The last rendered frame must contain evidence of a live connection, not
    // an error or offline state. The TUI chrome always includes the Host
    // connection status.
    const last = output.lastFrame
    expect(last).not.toMatch(/offline|incompatible-protocol|retrying/i)

    // A real snapshot was delivered over a real socket. The TUI maps the
    // HostSnapshot through mapHostSnapshotToControlSnapshot and renders it.
    // Even an empty world renders the status bar, composer prompt, and
    // (when there are no threads) some indication the TUI is alive.
    //
    // The critical proof is NOT that specific data appears — that depends on
    // journal state, which is empty on a fresh temp dir. The proof is that
    // the TUI completed a real round trip and rendered what the Host sent.
    // A disconnected TUI shows "Standalone Host offline" or "reconnecting";
    // a live TUI shows the Host connection status and its projection.
    expect(last.length).toBeGreaterThan(0)

    // After production start, the Host wrote its discovery and token files.
    // The client read them, opened the socket, completed the authenticated
    // handshake, and received a welcome with the lease-created production identity.
    //
    // RENDERED CONNECTION EVIDENCE (Wave 4.6a — hardened):
    // - Transient: "Connected to TaskWraith Host" notice (1.5s expiry).
    // - Durable:   renderHud paints "CONNECTED" in the footer bar when
    //              connection='connected' and no thread is active.
    // Boundary-anchored case-insensitive match catches both forms without
    // depending on the 1.5s window, and REJECTS "DISCONNECTED" / "disconnected"
    // (no word boundary before C — preceded by S). The negative lookbehind
    // also rejects "not connected" / "NOT CONNECTED" — reachable from
    // TaskWraithTui.ts L966: this.setNotice('TaskWraith Host is not connected.').
    // hostVersion is stored in state but is NOT painted to the terminal by
    // any render.ts code path — it was a dead branch and is intentionally removed.
    await waitFor(
      () => output.frames.some((frame) => /(?<!not\s+)\bCONNECTED\b/i.test(stripAnsi(frame))),
      'TUI renders Host connection evidence',
      3_000
    )
    expect(output.frames.some((frame) => stripAnsi(frame).includes('Host setup required'))).toBe(
      true
    )
  }, 20_000)

  it('reports the production Host as unreachable rather than rendering an empty world after async stop', async () => {
    const productionHost = await startProductionHost()
    await assertProductionWelcome()

    const { input, output } = makeTty()
    tui = new TaskWraithTui({
      clientVersion: 'tui-live-integration',
      userDataPath,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })

    await tui.start()

    // Prove we were connected before the stop — the TUI rendered the Host
    // connection chrome, not an error. Same anchored match as test 1
    // (Wave 4.6a): catches both the transient "Connected to TaskWraith Host"
    // notice and the durable "CONNECTED" in the HUD footer bar, and REJECTS
    // "DISCONNECTED" / "disconnected" (no word boundary before C) and
    // "not connected" (negative lookbehind).
    await waitFor(
      () => output.frames.some((frame) => /(?<!not\s+)\bCONNECTED\b/i.test(stripAnsi(frame))),
      'TUI was connected to real Host before stop',
      5_000
    )
    expect(output.lastFrame).not.toMatch(/offline|incompatible-protocol/i)

    // Stop the lease-owned Node Host asynchronously. This is the RED-proof: a
    // stopped Host must produce an unreachable/offline state, NOT an empty-world
    // render, and must release exactly the artifacts it owns.
    await productionHost.stop()
    expect(productionHost.phase).toBe('stopped')
    expectOwnedHostArtifactsReleased()

    // The TUI detects the socket close and fires 'disconnected'. The handler
    // sets connection='reconnecting' (because everConnected=true) and renders
    // a disconnected/reconnecting notice.
    await waitFor(
      () =>
        output.lastFrame.includes('disconnected') ||
        output.lastFrame.includes('reconnecting') ||
        output.lastFrame.includes('offline') ||
        output.lastFrame.includes('retrying'),
      'TUI reports Host unreachable after stop',
      8_000
    )

    // CRITICAL: the TUI must NOT render an empty world. "Unavailable telemetry
    // is not zero" — a dead Host must not present as an empty workspace list.
    // The TUI state at this point should show reconnecting/offline, not a
    // successful render of an empty snapshot.
    const afterStop = output.lastFrame
    expect(afterStop).toMatch(/disconnected|reconnecting|offline|retrying|unreachable/i)
  }, 25_000)

  // Wave 4.6a NEGATIVE PIN — the connection predicate MUST reject frames
  // that contain a connection-like word but are semantically negative.
  // Without this, the next person "simplifies" the regex and the stop RED-proof
  // silently stops testing anything. Verified by execution (pass 23):
  //   /(?<!not\s+)\bCONNECTED\b/i.test('DISCONNECTED') => false  (S→C = no word boundary)
  //   /(?<!not\s+)\bCONNECTED\b/i.test('TaskWraith Host is not connected.') => false  (negative lookbehind)
  //   /(?<!not\s+)\bCONNECTED\b/i.test('Connected to TaskWraith Host') => true
  //   /(?<!not\s+)\bCONNECTED\b/i.test('CONNECTED') => true
  it('the connection-evidence predicate rejects DISCONNECTED and not-connected frames', () => {
    const predicate = /(?<!not\s+)\bCONNECTED\b/i

    // renderHud L887: tone(ansi, state.connection.toUpperCase(), 'neutral')
    // When state.connection === 'disconnected', the HUD literally paints
    // the text "DISCONNECTED". The success predicate must NOT accept it.
    const disconnectedFrame = stripAnsi('DISCONNECTED — Standalone Host offline')
    expect(predicate.test(disconnectedFrame)).toBe(false)

    // TaskWraithTui.ts L966:
    //   this.setNotice('TaskWraith Host is not connected.', 'warning', 3_000)
    // The TUI's own "Host is not connected" warning contains "connected" with
    // word boundaries on BOTH sides (space before, period after). Without the
    // negative lookbehind, this would satisfy a predicate whose entire job is
    // to prove the Host IS connected. That is the same vacuity class as the
    // original /CONNECTED/i matching DISCONNECTED — a frame stating the literal
    // opposite of the claim satisfies the claim. Reachable from SHIPPING CODE.
    const notConnectedFrame = stripAnsi('TaskWraith Host is not connected.')
    expect(predicate.test(notConnectedFrame)).toBe(false)

    // Also reject uppercase variant.
    expect(predicate.test('NOT CONNECTED')).toBe(false)

    // Sanity: it still accepts the transient notice and the durable token.
    expect(predicate.test('Connected to TaskWraith Host')).toBe(true)
    expect(predicate.test('CONNECTED')).toBe(true)
  })
})
