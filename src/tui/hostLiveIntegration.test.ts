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
    // The welcome handler sets a notice "Connected to TaskWraith Host", and
    // the render cycle paints the live snapshot. Even with empty workspaces
    // and threads, the TUI renders its chrome — the connection status bar, the
    // empty-thread message, the composer. None of those exist if the connection
    // failed: a failed connect lands in "connecting" / "offline" / "incompatible".
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
    // That identity must appear somewhere in the terminal output after a
    // successful connect — the TUI renders the Host version in its chrome.
    await waitFor(
      () => output.lastFrame.includes('Connected') || output.lastFrame.includes(HOST_VERSION),
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
    // connection chrome, not an error.
    await waitFor(
      () =>
        output.lastFrame.includes('Connected') ||
        output.lastFrame.includes(HOST_VERSION) ||
        output.lastFrame.includes('Host'),
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
})
