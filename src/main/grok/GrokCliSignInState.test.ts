import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GROK_SIGN_IN_CHECK_ARGS,
  classifyGrokSignInOutput,
  readGrokCliSignInState
} from './GrokCliSignInState'

describe('classifyGrokSignInOutput', () => {
  // Every status line `grok models` (1.0.46) prints first, verbatim.
  it.each([
    'You are logged in with grok.com',
    'You are using XAI_API_KEY.',
    'You are authenticated via deployment key.',
    "Model 'grok-4.6' is using its own API key."
  ])('reads %j as signed in', (statusLine) => {
    expect(
      classifyGrokSignInOutput(`${statusLine}\n\nDefault model: grok-4.6\n\nAvailable models:\n`)
    ).toBe('signed_in')
  })

  it('reads the CLI\'s "You are not authenticated." as signed out', () => {
    expect(
      classifyGrokSignInOutput(
        'You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n'
      )
    ).toBe('signed_out')
  })

  it('reads the signed-out line through ANSI styling', () => {
    expect(classifyGrokSignInOutput('\x1b[1mYou are not authenticated.\x1b[0m\n')).toBe(
      'signed_out'
    )
  })

  it.each([
    ['nothing at all (the acceptance guard exits 0 silently)', ''],
    ['an unrecognised status line', 'Signed in as someone\nAvailable models:\n'],
    ['a clap usage error from a CLI without `models`', "error: unrecognized subcommand 'models'\n"]
  ])('cannot tell from %s', (_case, output) => {
    expect(classifyGrokSignInOutput(output)).toBe('unknown')
  })
})

const DIR_PREFIX = 'grok-sign-in-state-'
let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), DIR_PREFIX))
  mkdirSync(join(dir, 'home'))
})

afterEach(() => {
  // Remove only the directory mkdtemp returned for this test.
  if (dir && dirname(dir) === tmpdir() && basename(dir).startsWith(DIR_PREFIX)) {
    rmSync(dir, { recursive: true, force: true })
  }
  dir = ''
})

function writeStandIn(body: string[]): string {
  const binaryPath = join(dir, 'grok')
  // @portability-ok: POSIX stand-in; the suite below is skipped on win32.
  writeFileSync(binaryPath, ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 })
  return binaryPath
}

describe.skipIf(process.platform === 'win32')('readGrokCliSignInState', () => {
  it('asks the CLI non-interactively, with no stdin and the environment it was given', async () => {
    const binaryPath = writeStandIn([
      `printf '%s\\n' "$*" > '${join(dir, 'args')}'`,
      `printf '%s\\n' "$HOME" > '${join(dir, 'home-seen')}'`,
      `printf '%s\\n' "$NO_COLOR" > '${join(dir, 'no-color-seen')}'`,
      // A terminal left attached would block here until the check gave up.
      `cat > '${join(dir, 'stdin-seen')}'`,
      "printf 'You are not authenticated.\\n'"
    ])

    await expect(
      readGrokCliSignInState({
        binaryPath,
        env: { PATH: process.env.PATH, HOME: join(dir, 'home') },
        timeoutMs: 4000
      })
    ).resolves.toBe('signed_out')

    expect(readFileSync(join(dir, 'args'), 'utf8')).toBe(`${GROK_SIGN_IN_CHECK_ARGS.join(' ')}\n`)
    expect(GROK_SIGN_IN_CHECK_ARGS).toEqual(['--no-auto-update', 'models'])
    expect(readFileSync(join(dir, 'home-seen'), 'utf8')).toBe(`${join(dir, 'home')}\n`)
    expect(readFileSync(join(dir, 'no-color-seen'), 'utf8')).toBe('1\n')
    expect(readFileSync(join(dir, 'stdin-seen'), 'utf8')).toBe('')
  })

  it('asks again when the first answer may only mean a session that was due a refresh', async () => {
    // `grok models` reports the credential it started with and renews an
    // expired session while it runs: this stand-in says "not authenticated"
    // once, renews, and says "logged in" when asked again.
    const runs = join(dir, 'runs')
    const renewed = join(dir, 'renewed')
    const binaryPath = writeStandIn([
      `echo run >> '${runs}'`,
      `if [ -e '${renewed}' ]; then printf 'You are logged in with grok.com\\n'; exit 0; fi`,
      `: > '${renewed}'`,
      "printf 'You are not authenticated.\\n'"
    ])

    await expect(
      readGrokCliSignInState({ binaryPath, env: { PATH: process.env.PATH }, timeoutMs: 4000 })
    ).resolves.toBe('signed_in')
    expect(readFileSync(runs, 'utf8')).toBe('run\nrun\n')
  })

  it('reports signed out when the CLI says so on both askings', async () => {
    const runs = join(dir, 'runs')
    const binaryPath = writeStandIn([
      `echo run >> '${runs}'`,
      "printf 'You are not authenticated.\\n'"
    ])

    await expect(
      readGrokCliSignInState({ binaryPath, env: { PATH: process.env.PATH }, timeoutMs: 4000 })
    ).resolves.toBe('signed_out')
    expect(readFileSync(runs, 'utf8')).toBe('run\nrun\n')
  })

  it('asks a signed-in CLI only once', async () => {
    const runs = join(dir, 'runs')
    const binaryPath = writeStandIn([
      `echo run >> '${runs}'`,
      "printf 'You are logged in with grok.com\\n'"
    ])

    await expect(
      readGrokCliSignInState({ binaryPath, env: { PATH: process.env.PATH }, timeoutMs: 4000 })
    ).resolves.toBe('signed_in')
    expect(readFileSync(runs, 'utf8')).toBe('run\n')
  })

  it('reports a signed-in CLI as signed in', async () => {
    const binaryPath = writeStandIn([
      "printf 'You are logged in with grok.com\\n\\nDefault model: grok-4.6\\n'"
    ])

    await expect(
      readGrokCliSignInState({ binaryPath, env: { PATH: process.env.PATH }, timeoutMs: 4000 })
    ).resolves.toBe('signed_in')
  })

  it('reads a status line the CLI writes to stderr', async () => {
    const binaryPath = writeStandIn(["printf 'You are not authenticated.\\n' >&2"])

    await expect(
      readGrokCliSignInState({ binaryPath, env: { PATH: process.env.PATH }, timeoutMs: 4000 })
    ).resolves.toBe('signed_out')
  })

  it('gives up as unknown on a CLI that does not answer in time, and ends it', async () => {
    const pidFile = join(dir, 'pid')
    const binaryPath = writeStandIn([`echo $$ > '${pidFile}'`, 'exec sleep 30'])

    const startedAt = Date.now()
    await expect(
      readGrokCliSignInState({ binaryPath, env: { PATH: process.env.PATH }, timeoutMs: 300 })
    ).resolves.toBe('unknown')
    expect(Date.now() - startedAt).toBeLessThan(3000)

    expect(existsSync(pidFile)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(pid).toBeGreaterThan(0)
    // A killed child answers kill(pid, 0) until it is reaped; allow for that,
    // well inside the 30s the stand-in would otherwise live.
    const isAlive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const deadline = Date.now() + 2000
    while (isAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(isAlive()).toBe(false)
  })

  it('reports unknown when the binary cannot be started', async () => {
    await expect(
      readGrokCliSignInState({
        binaryPath: join(dir, 'no-such-grok'),
        env: { PATH: process.env.PATH },
        timeoutMs: 4000
      })
    ).resolves.toBe('unknown')
  })
})
