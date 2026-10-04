import { beforeEach, describe, expect, it } from 'vitest'
import type { AcpChildProcess } from './AcpTurnClient'
import { runAntigravityAcpTurn } from '../antigravity/AntigravityAcpClient'
import { runDevinAcpTurn } from '../devin/DevinAcpClient'
import { runGrokAcpTurn } from '../grok/GrokAcpClient'
import { runKimiAcpTurn } from '../kimi/KimiAcpClient'
import { runMistralAcpTurn } from '../mistral/MistralAcpClient'
import {
  orderedStreamPumpCounters,
  resetOrderedStreamPumpCountersForTest
} from '../providers/CooperativeStreamPump'

/** A provider process that says nothing and closes as soon as it is stopped. */
class SilentAcpChild implements AcpChildProcess {
  private closeListener?: (code: number | null) => void
  stdin = { write: (): void => {} }
  stdout = { on: (): void => {} }
  stderr = { on: (): void => {} }
  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
  }
  kill(): void {
    this.closeListener?.(0)
  }
}

const turn = {
  prompt: 'hi',
  cwd: '/tmp/ws',
  cwdLifetime: 'run' as const,
  appVersion: '0.0.0-test',
  onEvent: (): void => {}
}

const PROVIDER_TURNS: Array<[string, string, (child: AcpChildProcess) => { cancel(): void }]> = [
  [
    'antigravity',
    'antigravity',
    (child) => runAntigravityAcpTurn({ ...turn, spawnProcess: () => child })
  ],
  ['devin', 'devin', (child) => runDevinAcpTurn({ ...turn, spawnProcess: () => child })],
  ['grok', 'grok', (child) => runGrokAcpTurn({ ...turn, spawnProcess: () => child })],
  ['kimi', 'kimi', (child) => runKimiAcpTurn({ ...turn, spawnProcess: () => child })],
  [
    'mistral (introduction turn)',
    'mistral',
    (child) => runMistralAcpTurn({ ...turn, spawnProcess: () => child })
  ],
  [
    'mistral (working turn)',
    'mistral',
    (child) => runMistralAcpTurn({ ...turn, skipIntroduction: true, spawnProcess: () => child })
  ]
]

beforeEach(() => {
  resetOrderedStreamPumpCountersForTest()
})

describe('each ACP provider counts its output under its own provider id', () => {
  it.each(PROVIDER_TURNS)('%s', (_name, label, start) => {
    const handle = start(new SilentAcpChild())

    // Exactly one group: a provider that fell back to the shared `acp` default
    // would be indistinguishable from the others in the diagnostics snapshot.
    expect(orderedStreamPumpCounters()).toEqual({
      [label]: expect.objectContaining({ pumps: 1 })
    })
    handle.cancel()
  })
})
