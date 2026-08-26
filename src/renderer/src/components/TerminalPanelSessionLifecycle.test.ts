import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Slice D — machine-checked half of the composer PTY lifecycle contract.
 *
 * `TerminalPanel` used to compute its PTY session id *inside* the terminal
 * setup effect while that effect depended only on `[sessionId, workspacePath,
 * theme]`. Switching between two chats in the same workspace therefore changed
 * the id without re-running the effect: the panel kept writing to and reading
 * from the previous chat's shell, and the new chat's shell was never started.
 *
 * There is no DOM environment configured for renderer tests in this repo, so
 * this pins the contract at the source level: the id is derived during render,
 * it is a real dependency of the setup effect, and every PTY call routes on
 * exactly that id.
 */

const SOURCE_PATH = join(process.cwd(), 'src/renderer/src/components/TerminalPanel.tsx')

const readSource = (): string => readFileSync(SOURCE_PATH, 'utf8').replace(/\r\n/g, '\n')

/** First statement of the terminal setup effect, used as its start anchor. */
const SETUP_EFFECT_ANCHOR = 'const host = terminalRef.current'

interface SetupEffect {
  /** Everything from the first statement up to the dependency array. */
  body: string
  /** The literal dependency array, `[` and `]` included. */
  deps: string
}

function readSetupEffect(source: string): SetupEffect {
  const start = source.indexOf(SETUP_EFFECT_ANCHOR)
  expect(start, 'Missing the terminal setup effect').toBeGreaterThan(0)
  const depsStart = source.indexOf('}, [', start)
  expect(depsStart, 'Missing the setup effect dependency array').toBeGreaterThan(start)
  const depsEnd = source.indexOf('])', depsStart)
  expect(depsEnd, 'Unterminated setup effect dependency array').toBeGreaterThan(depsStart)
  return { body: source.slice(start, depsStart), deps: source.slice(depsStart + 3, depsEnd + 1) }
}

function dependencyNames(deps: string): string[] {
  return deps
    .replace(/[[\]]/g, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

describe('TerminalPanel PTY session lifecycle', () => {
  it('derives the effective session id during render, not inside the setup effect', () => {
    const source = readSource()
    const declaration = source.indexOf('const effectivePtySessionId = propPtySessionId ||')
    expect(
      declaration,
      'The effective session id must be derived at component scope'
    ).toBeGreaterThan(0)

    // Derived strictly before the effect that consumes it, so it can be named
    // as a dependency at all.
    expect(declaration).toBeLessThan(source.indexOf(SETUP_EFFECT_ANCHOR))

    const { body } = readSetupEffect(source)
    // Recomputing it inside the effect is exactly how the id escaped the
    // dependency array the first time.
    expect(body).not.toMatch(/const\s+effectivePtySessionId/)
    expect(body).not.toContain('propPtySessionId')
  })

  it('re-runs the setup effect when the chat changes within one workspace', () => {
    const { deps } = readSetupEffect(readSource())

    expect(dependencyNames(deps)).toEqual(['effectivePtySessionId', 'workspacePath', 'theme'])
  })

  it('routes every PTY call through the effective session id', () => {
    const { body } = readSetupEffect(readSource())

    const calls = [
      ...body.matchAll(/window\.api\.(startPty|stopPty|ptyWrite|ptyResize)\(([^)]*)\)/g)
    ]
    expect(calls.map(([, name]) => name).sort()).toEqual([
      'ptyResize',
      'ptyWrite',
      'startPty',
      'stopPty'
    ])
    for (const [, name, args] of calls) {
      expect(args.trim().endsWith('effectivePtySessionId'), `${name} must route on the id`).toBe(
        true
      )
    }

    // Inbound data/exit frames are filtered against the same id, so a stale
    // shell cannot paint into the new chat's terminal.
    expect(body.match(/eventSessionId !== effectivePtySessionId/g)).toHaveLength(2)
  })

  it('keeps close semantics: cleanup stops the outgoing session', () => {
    const { body } = readSetupEffect(readSource())
    const cleanup = body.slice(body.indexOf('return () => {'))

    expect(cleanup, 'Missing the setup effect cleanup').toContain('disposed = true')
    // The cleanup closes over the id it was created with, so a chat switch
    // stops exactly the shell it started. Pane close still terminates.
    expect(cleanup).toContain('window.api.stopPty(effectivePtySessionId)')
  })

  it('does not restart the PTY when the ready callback identity changes', () => {
    const source = readSource()
    const { body, deps } = readSetupEffect(source)

    // The composer's callback clears the pending-command map it closes over,
    // so its identity changes on every flush. As a dependency it would respawn
    // the shell the moment the terminal reported ready, in a loop.
    expect(dependencyNames(deps)).not.toContain('onTerminalReady')
    expect(body).toContain('onTerminalReadyRef.current?.()')
    expect(body).not.toContain('onTerminalReady?.()')

    // The ref is kept current by its own effect rather than by silencing the
    // dependency lint.
    expect(source).toContain('onTerminalReadyRef.current = onTerminalReady')
    expect(source).not.toMatch(/eslint-disable[^\n]*react-hooks\/exhaustive-deps/)
  })
})
