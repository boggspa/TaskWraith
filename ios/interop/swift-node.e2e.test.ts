/*
 * Live Swift ↔ Node interop e2e (T4d) — the cross-implementation acceptance
 * bar. The same pair→snapshot→action→drop/resume contract the Node-only
 * keystone (tests/fake-iphone/e2e.pairing-and-actions.test.ts) proves, but with
 * the phone replaced by the REAL CryptoKit RelayTransportClient (the
 * tw-interop-cli Swift binary) talking to the REAL Node relay + RemoteBridgeRuntime
 * + BridgeActionRouter over real WebSockets.
 *
 * Tracked but opt-in. Gated behind RUN_SWIFT_INTEROP so a bare `npm test`
 * skips it; run explicitly after building the Swift package:
 *
 *   (cd ios/TaskWraithKit && swift build)
 *   RUN_SWIFT_INTEROP=1 npx vitest run ios/interop/swift-node.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRelayServer, type RelayServerHandle } from '../../relay/src/server'
import {
  RemoteBridgeRuntime,
  type RemotePairingPrompt,
  type RemotePairingPersistence
} from '../../src/main/remote/RemoteBridgeRuntime'
import type { PersistedRemotePairing } from '../../src/main/remote/RemotePairingStore'
import { wsTransportSocketFactory } from '../../src/main/remote/wsTransportSocket'
import { BridgeActionRouter } from '../../src/main/BridgeActionRouter'
import { RemoteWorkspaceAllowlist } from '../../src/main/RemoteWorkspaceAllowlist'
import type {
  BridgeActionExecutionResult,
  BridgeActionExecutor
} from '../../src/main/BridgeActionExecutor'
import { buildRemoteProjectionEnvelope } from '../../src/main/RemoteTaskProjection'

const PKG_DIR = join(__dirname, '..', 'TaskWraithKit')
const enabled = process.env.RUN_SWIFT_INTEROP === '1' && existsSync(PKG_DIR)

function swiftBinPath(): string {
  const binDir = execFileSync('swift', ['build', '--show-bin-path'], {
    cwd: PKG_DIR,
    encoding: 'utf8'
  }).trim()
  return join(binDir, 'tw-interop-cli')
}

const EXECUTOR_METHODS = [
  'executeApprovalReply', 'executeQuestionReply', 'executeQuestionReject', 'executeComposerPrompt',
  'executeCancelRun', 'executeEnsembleCancelRound', 'executeEnsembleSkipActiveParticipant',
  'executeEnsembleWakeNow', 'executeEnsembleCancelWakeup', 'executeEnsembleQueuePrompt',
  'executeEnsembleSteer', 'executeRegisterApnsToken', 'executeSetYoloMode', 'executeTogglePinChat',
  'executeTogglePinWorkspace'
] as const

function spyExecutor(): { executor: BridgeActionExecutor; calls: string[] } {
  const calls: string[] = []
  const e = {} as Record<string, (p: unknown) => Promise<BridgeActionExecutionResult>>
  for (const m of EXECUTOR_METHODS) {
    e[m] = async () => {
      calls.push(m)
      return { executed: true, message: `${m} ok` }
    }
  }
  return { executor: e as unknown as BridgeActionExecutor, calls }
}

function memoryPairingStore(): RemotePairingPersistence {
  // Multi-device store shape (5b9ccf7e) — the runtime calls list/upsert/
  // remove; load/save remain as the deprecated single-device shims.
  let records: PersistedRemotePairing[] = []
  return {
    list: () => [...records],
    upsert: (pairing) => {
      records = [
        ...records.filter(
          (entry) => entry.iphoneIdentityPubKey !== pairing.iphoneIdentityPubKey
        ),
        pairing
      ]
    },
    remove: (iphoneIdentityPubKey) => {
      const before = records.length
      records = records.filter(
        (entry) => entry.iphoneIdentityPubKey !== iphoneIdentityPubKey
      )
      return records.length !== before
    },
    load: () => records[0] ?? null,
    save: (pairing) => {
      records = [pairing]
    },
    clear: () => {
      records = []
    }
  }
}

describe.skipIf(!enabled)('Swift ↔ Node live interop', () => {
  let relay: RelayServerHandle
  let runtime: RemoteBridgeRuntime
  let relayUrl = ''
  const prompts: RemotePairingPrompt[] = []
  const { executor, calls } = spyExecutor()
  let binPath = ''

  beforeAll(async () => {
    binPath = swiftBinPath()
    if (!existsSync(binPath)) throw new Error(`Swift binary not built: ${binPath}`)
    relay = await createRelayServer({ port: 0, resolve: { freshnessMs: 60_000 } })
    relayUrl = `ws://127.0.0.1:${relay.port}`

    const allowlist = new RemoteWorkspaceAllowlist({})
    allowlist.upsert({
      workspaceId: 'ws-allowed',
      path: '/tmp/interop-ws',
      mode: 'read-write'
    })
    const router = new BridgeActionRouter({ allowlist, executor, log: () => {} })
    const envelope = buildRemoteProjectionEnvelope({
      kind: 'taskCard',
      payload: { id: 'chat-interop', title: 'Interop task' },
      generatedAt: '2026-06-09T00:00:00.000Z',
      envelopeId: 'remote-task:chat-interop:no-run'
    })
    runtime = new RemoteBridgeRuntime({
      relayUrl,
      macDisplayName: 'Interop Mac',
      identity: (await import('../../src/shared/e2ee/keys')).generateIdentityKeyPair(),
      socketFactory: wsTransportSocketFactory,
      appStore: { getWorkspaces: () => [], getChats: () => [], getChat: () => null },
      projectionSource: { listRemoteProjectionEnvelopes: () => [envelope] },
      routeAction: (m, p) => router.route(m, p),
      subscribeRunEvents: () => () => {},
      onPairingPrompt: (prompt) => {
        prompts.push(prompt)
        // Auto-confirm: stand in for the user tapping "Pair".
        runtime.finalizePairing(prompt.sessionID, true)
      },
      pairingStore: memoryPairingStore()
    })
  })

  afterAll(async () => {
    runtime?.dispose()
    await relay?.close()
  })

  it('pairs, snapshots, acts, and survives a trusted reconnect', async () => {
    const begin = runtime.beginPairing('Interop iPad')
    const bootstrapJson = JSON.stringify(begin.bootstrap.bootstrapPayload)

    // The relay forwards verbatim only when both peers are present (no
    // buffering). Wait for the Mac socket to join the room before launching the
    // phone, so the phone's clientHello can't be dropped. (In production the Mac
    // is always listening first — QR scan / resolve both follow Mac-listen.)
    const deadline = Date.now() + 5000
    while (relay.roomCount() < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(relay.roomCount(), 'Mac socket joined relay room').toBeGreaterThanOrEqual(1)

    const lines: string[] = []
    let stderr = ''
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(binPath, [bootstrapJson], { stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Swift CLI timed out. stdout=${lines.join('|')} stderr=${stderr}`))
      }, 40_000)
      child.stdout.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n')) {
          if (line.trim()) lines.push(line.trim())
        }
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(code ?? -1)
      })
    })

    // The Swift client succeeded end-to-end.
    expect(exitCode, `CLI stdout: ${lines.join(' | ')}\nstderr: ${stderr}`).toBe(0)

    // (1) Pairing: the Swift-derived confirm code equals the Mac's prompt code.
    const confirmLine = lines.find((l) => l.startsWith('CONFIRM '))
    expect(confirmLine).toBeDefined()
    expect(prompts.length).toBeGreaterThanOrEqual(1)
    expect(confirmLine).toBe(`CONFIRM ${prompts[0].code}`)

    // (2) Snapshot, (3) action accepted, (4) trusted reconnect.
    expect(lines).toContain('SNAPSHOT ok')
    expect(lines).toContain('ACK true')
    expect(lines).toContain('RECONNECT ok')
    expect(lines).toContain('DONE')

    // The allowlisted cancelRun reached the real executor through the router.
    expect(calls).toContain('executeCancelRun')
  }, 60_000)
})
