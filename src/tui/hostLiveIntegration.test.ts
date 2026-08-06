/**
 * Wave 4.6 — THE TUI AGAINST A REAL HOST.
 *
 * Every TUI test to date drives a TCP Fake Host. This is the first time any
 * client actually talks to a real Host over a real authenticated unix socket.
 *
 * Wave 4.4 proved `createHostProductionBootstrap` boots the REAL composition
 * over a REAL unix socket. This file inherits that discipline exactly —
 * `createComposition` and `createServer` are deliberately OMITTED so the
 * production defaults run — and points the REAL TUI projection path at it.
 *
 * SEAT REQUIREMENT: this suite performs a real unix-domain socket listen.
 * Sandboxed seats that return EPERM on `listen()` cannot run it. This Pi seat
 * was probed before authoring: LISTEN OK.
 *
 * SAFETY: every test uses `fs.mkdtemp` ONLY. It must NEVER use a real userData
 * profile — a live TaskWraith app would collide with it. Zero stray sockets or
 * temp dirs remain after the suite completes.
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ReadStream, WriteStream } from 'node:tty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createHostProductionBootstrap,
  type HostProductionBootstrapOptions
} from '../main/host/HostProductionBootstrap'
import type { HostSupervisor } from '../main/host/HostSupervisor'
import { stripAnsi } from './ansi'
import { TaskWraithTui } from './TaskWraithTui'

/* -------------------------------------------------------------------------
 * Stub boundaries — chatList and bridge are genuinely external
 * (AppStore / BridgeActionExecutor). Everything on the transport path is real.
 * ---------------------------------------------------------------------- */

const HOST_ID = 'tui-live-integration-host'
const HOST_VERSION = '0.0.0-tui-live'

function externalChatList(): HostProductionBootstrapOptions['chatList'] {
  return { getChatList: vi.fn().mockReturnValue([]) }
}

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

/** NOTE THE ABSENCES. `createComposition` and `createServer` are deliberately
 *  NOT provided — the production defaults run. This is the exact discipline
 *  from Wave 4.4. */
function productionOptions(userDataPath: string): HostProductionBootstrapOptions {
  return {
    userDataPath,
    chatList: externalChatList(),
    bridge: externalBridge(),
    host: { hostId: HOST_ID, hostVersion: HOST_VERSION }
  }
}

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
 * Suite lifecycle — safety discipline inherited from Wave 4.4
 * ---------------------------------------------------------------------- */

let userDataPath: string
let supervisor: HostSupervisor | null = null
let tui: TaskWraithTui | null = null

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'tw-tui-live-host-'))
  supervisor = null
  tui = null
})

afterEach(() => {
  // Teardown must survive a failed assertion mid-test, or one red test leaves a
  // live listener that hangs the suite.
  try {
    tui?.stop()
  } catch {
    /* tui already stopped or never started */
  }
  try {
    supervisor?.stopSync()
  } catch {
    /* supervisor already stopped or never started */
  }
  rmSync(userDataPath, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

describe('Wave 4.6 — TUI against a real Host', () => {
  it('connects to a real Host over a real unix socket and renders a live snapshot', async () => {
    supervisor = createHostProductionBootstrap(productionOptions(userDataPath))
    await supervisor.start()

    const { input, output } = makeTty()
    tui = new TaskWraithTui({
      clientVersion: HOST_VERSION,
      userDataPath,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })

    await tui.start()

    // After start() resolves, the TUI has connected and retrieved a snapshot
    // from a real Host over a real unix socket — the first time any client has
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
    // A disconnected TUI shows "Electron Host offline" or "reconnecting";
    // a live TUI shows the Host connection status and its projection.
    expect(last.length).toBeGreaterThan(0)

    // After a real bootstrap, the Host wrote its discovery and token files.
    // The client read them, opened the socket, completed the authenticated
    // handshake, and received a welcome with the identity we injected.
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
      () => /(?<!not\s+)\bCONNECTED\b/i.test(output.lastFrame),
      'TUI renders Host connection evidence',
      3_000
    )
  }, 20_000)

  it('reports the Host as unreachable rather than rendering an empty world when the socket dies', async () => {
    supervisor = createHostProductionBootstrap(productionOptions(userDataPath))
    await supervisor.start()

    const { input, output } = makeTty()
    tui = new TaskWraithTui({
      clientVersion: HOST_VERSION,
      userDataPath,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })

    await tui.start()

    // Prove we were connected before the kill — the TUI rendered the Host
    // connection chrome, not an error. Same anchored match as test 1
    // (Wave 4.6a): catches both the transient "Connected to TaskWraith Host"
    // notice and the durable "CONNECTED" in the HUD footer bar, and REJECTS
    // "DISCONNECTED" / "disconnected" (no word boundary before C) and
    // "not connected" (negative lookbehind).
    await waitFor(
      () => /(?<!not\s+)\bCONNECTED\b/i.test(output.lastFrame),
      'TUI was connected to real Host before kill',
      5_000
    )
    expect(output.lastFrame).not.toMatch(/offline|incompatible-protocol/i)

    // Kill the Host. This is the RED-proof: a dead Host must produce an
    // unreachable/offline state, NOT an empty-world render.
    supervisor.stopSync()

    // The TUI detects the socket close and fires 'disconnected'. The handler
    // sets connection='reconnecting' (because everConnected=true) and renders
    // a disconnected/reconnecting notice.
    await waitFor(
      () =>
        output.lastFrame.includes('disconnected') ||
        output.lastFrame.includes('reconnecting') ||
        output.lastFrame.includes('offline') ||
        output.lastFrame.includes('retrying'),
      'TUI reports Host unreachable after kill',
      8_000
    )

    // CRITICAL: the TUI must NOT render an empty world. "Unavailable telemetry
    // is not zero" — a dead Host must not present as an empty workspace list.
    // The TUI state at this point should show reconnecting/offline, not a
    // successful render of an empty snapshot.
    const afterKill = output.lastFrame
    expect(afterKill).toMatch(/disconnected|reconnecting|offline|retrying|unreachable/i)
  }, 25_000)

  // Wave 4.6a NEGATIVE PIN — the connection predicate MUST reject frames
  // that contain a connection-like word but are semantically negative.
  // Without this, the next person "simplifies" the regex and the kill RED-proof
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
    const disconnectedFrame = stripAnsi('DISCONNECTED — Electron Host offline')
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
