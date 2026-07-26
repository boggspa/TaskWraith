// LIVE end-to-end exercise of the Mistral Vibe ACP lane against the real
// `vibe-acp` binary. Skipped unless TASKWRAITH_MISTRAL_LIVE=1.
//
// Opt-in because it spawns a real process, talks to Mistral's API and consumes
// a small amount of the signed-in plan's allowance. It is committed rather than
// left as a throwaway script because it is the ONLY thing that exercises the
// parts of this seat that unit tests structurally cannot:
//
//   * the clientInfo trap — an empty client_version is rejected as an opaque
//     -32603 that unit tests, which never reach the network, cannot see;
//   * `session/set_config_option` actually being ACCEPTED for `mode` and
//     `model`. This seat has no CLI surface, so a rejected option is the
//     difference between a read-only seat and a write-capable one, and the
//     rejection is silent — the session still opens and the prompt still
//     succeeds;
//   * the credential lane — that a scrubbed env really does land on the
//     plan/browser-auth sign-in rather than the metered API key.
//
// Run it with:
//   TASKWRAITH_MISTRAL_LIVE=1 npx vitest run src/main/mistral/MistralAcpLive.test.ts

import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  MISTRAL_BINARY_NAME,
  MISTRAL_DEFAULT_MODEL,
  mistralSessionModeForSeat,
  scrubMistralCredentialEnv
} from './MistralCliArgs'
import { runMistralAcpTurn, type AcpChildProcess } from './MistralAcpClient'
import type { NormalizedGrokRunEvent } from '../grok/GrokAcpProtocol'

const LIVE = process.env.TASKWRAITH_MISTRAL_LIVE === '1'
const describeLive = LIVE ? describe : describe.skip

describeLive('Mistral Vibe ACP — live turn', () => {
  it('completes a real read-only turn with mode and model selected over the protocol', async () => {
    const events: NormalizedGrokRunEvent[] = []
    const frames: Array<{ direction: 'in' | 'out'; message: unknown }> = []

    // The credential lane under test: a scrubbed env must fall through to the
    // plan sign-in. If MISTRAL_API_KEY survived here the turn would still
    // succeed — on the user's metered API billing — which is exactly why this
    // is asserted rather than trusted.
    const env = scrubMistralCredentialEnv(process.env as Record<string, string | undefined>)
    expect(env.MISTRAL_API_KEY).toBeUndefined()

    const handle = runMistralAcpTurn({
      prompt: 'Reply with exactly the single word READY and nothing else. Do not call any tools.',
      cwd: process.cwd(),
      appVersion: '1.9.0-live-test',
      spawnProcess: () =>
        spawn(MISTRAL_BINARY_NAME, [], {
          cwd: process.cwd(),
          shell: false,
          env: env as NodeJS.ProcessEnv
        }) as unknown as AcpChildProcess,
      sessionConfigOptions: [
        { configId: 'mode', value: mistralSessionModeForSeat(true) },
        { configId: 'model', value: MISTRAL_DEFAULT_MODEL }
      ],
      // Fail closed, exactly as a read-only seat does in production.
      onPermissionRequest: () => 'deny',
      onEvent: (event) => events.push(event),
      onRawFrame: (direction, message) => frames.push({ direction, message })
    })

    await handle.closed

    const warnings = events
      .filter((event) => event.type === 'provider_warning')
      .map((event) => String((event as { text?: string }).text || ''))
    // A rejected config option surfaces as a provider_warning rather than a
    // failure, which is precisely how a read-only seat could silently run
    // write-capable. Treat any config-option warning as a hard failure here.
    expect(warnings.filter((text) => /config option/i.test(text))).toEqual([])

    const text = events
      .filter((event) => event.type === 'content')
      .map((event) => String((event as { text?: string }).text || ''))
      .join('')
    expect(text.toUpperCase()).toContain('READY')

    // Proves the handshake carried a non-empty clientInfo. An empty
    // client_version would have failed the prompt with an opaque -32603.
    const initFrame = frames.find(
      (frame) =>
        frame.direction === 'out' && (frame.message as { method?: string })?.method === 'initialize'
    )
    const clientInfo = (
      initFrame?.message as { params?: { clientInfo?: { name?: string; version?: string } } }
    )?.params?.clientInfo
    expect(clientInfo?.name).toBeTruthy()
    expect(clientInfo?.version).toBeTruthy()
  }, 120_000)
})
