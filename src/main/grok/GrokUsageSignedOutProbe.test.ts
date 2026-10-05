import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GROK_USAGE_BINARY_OVERRIDE_ENV,
  resolveGrokUsageProbeBinary
} from './GrokUsageBinaryOverride'
import {
  parseGrokUsage,
  probeGrokUsage,
  type GrokPtyLike,
  type GrokUsageSnapshot
} from './GrokUsage'

// End to end against stand-in grok executables. The real CLI, launched as the
// interactive TUI while it holds no usable credential, starts its own sign-in
// on launch: it fetches a device code and opens the default browser about a
// tenth of a second later, whatever the probe types. These stand-ins do the
// same, except that their "browser" is a recorder, so a regression shows up
// as a marker file rather than as a login page on the machine running the
// suite.

const DIR_PREFIX = 'grok-usage-signed-out-'
const FIXED_NOW = '2026-10-05T00:00:00.000Z'
const SIGN_IN_URL = 'https://accounts.x.ai/oauth2/device?user_code=TEST-0000'

let dir = ''
const children: ChildProcessWithoutNullStreams[] = []

function killGroup(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return
  try {
    // Spawned detached, so the stand-in leads its own process group and this
    // also reaches the `sleep` and `cat` it starts.
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), DIR_PREFIX))
  mkdirSync(join(dir, 'stubs'))
  mkdirSync(join(dir, 'home'))
  mkdirSync(join(dir, 'cwd'))
  for (const name of ['open', 'browser']) {
    // @portability-ok: POSIX stand-ins; the suite below is skipped on win32.
    writeFileSync(
      join(dir, 'stubs', name),
      ['#!/bin/sh', `printf '%s\\n' "$*" >> '${join(dir, 'browser-opened')}'`, ''].join('\n'),
      { mode: 0o755 }
    )
  }
})

afterEach(() => {
  for (const child of children.splice(0)) killGroup(child)
  // Remove only the directory mkdtemp returned for this test.
  if (dir && dirname(dir) === tmpdir() && basename(dir).startsWith(DIR_PREFIX)) {
    rmSync(dir, { recursive: true, force: true })
  }
  dir = ''
})

interface StandInOptions {
  /** The auth line `grok models` prints first, exactly as the CLI words it. */
  modelsAuthLine: string
  /**
   * The line once a first `grok models` has renewed an expired session; that
   * first run still reports the expired credential it started with.
   */
  modelsAuthLineOnceRenewed?: string
  /** What the interactive TUI does once launched. */
  tui: 'begins-sign-in' | 'shows-usage'
  /** Seconds between the sign-in screen and the browser launch. */
  browserDelaySeconds?: number
}

function writeStandInGrok(options: StandInOptions): string {
  const binaryPath = join(dir, 'grok')
  const signInBody = [
    "printf 'Approve in your browser to finish signing in.\\r\\nMake sure your browser shows this code.\\r\\nWaiting for approval...\\r\\n'",
    `sleep ${options.browserDelaySeconds ?? 0.3}`,
    `url='${SIGN_IN_URL}'`,
    'if [ -n "$BROWSER" ]; then "$BROWSER" "$url"; else open "$url"; fi',
    'exec sleep 30'
  ]
  const usageBody = [
    "printf 'Welcome to Grok\\r\\n'",
    'while IFS= read -r line; do',
    `  printf '%s\\n' "$line" >> '${join(dir, 'tui-stdin')}'`,
    '  case "$line" in',
    "    */usage*) printf 'Weekly limit: 42%%\\r\\nNext reset: July 2, 09:04 PT\\r\\n' ;;",
    '  esac',
    'done'
  ]
  const script = [
    // @portability-ok: POSIX stand-in; the suite below is skipped on win32.
    '#!/bin/sh',
    // `open` always resolves to the recorder, never to the system command.
    `PATH='${join(dir, 'stubs')}':"$PATH"`,
    'export PATH',
    'for arg in "$@"; do',
    '  if [ "$arg" = models ]; then',
    `    printf '%s\\n' "$*" >> '${join(dir, 'models-args')}'`,
    `    status='${options.modelsAuthLine}'`,
    ...(options.modelsAuthLineOnceRenewed
      ? [
          `    if [ -e '${join(dir, 'renewed')}' ]; then status='${options.modelsAuthLineOnceRenewed}'; fi`,
          `    : > '${join(dir, 'renewed')}'`
        ]
      : []),
    `    printf '%s\\n\\nDefault model: grok-4.6\\n\\nAvailable models:\\n  * grok-4.6 (default)\\n' "$status"`,
    '    exit 0',
    '  fi',
    'done',
    `: > '${join(dir, 'tui-started')}'`,
    ...(options.tui === 'begins-sign-in'
      ? [`cat >> '${join(dir, 'tui-stdin')}' &`, ...signInBody]
      : usageBody),
    ''
  ].join('\n')
  writeFileSync(binaryPath, script, { mode: 0o755 })
  return binaryPath
}

/**
 * A GrokPtyLike over pipes. The probe ends `/usage` with a carriage return;
 * a real pty's line discipline turns that into the newline a line-reading
 * stand-in waits for (ICRNL), so this does the same translation explicitly.
 */
function spawnPipeTerminal(binaryPath: string, env: NodeJS.ProcessEnv): GrokPtyLike {
  const child = spawn(binaryPath, ['--no-auto-update', '--no-alt-screen'], {
    cwd: join(dir, 'cwd'),
    env: { ...env, TERM: 'xterm-256color', NO_COLOR: '1' },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.push(child)
  child.stdin.on('error', () => {
    // The probe may write after the stand-in has been killed.
  })
  return {
    onData: (listener) => {
      child.stdout.on('data', (chunk) => listener(String(chunk)))
      child.stderr.on('data', (chunk) => listener(String(chunk)))
    },
    onExit: (listener) => {
      child.on('exit', (code) => listener({ exitCode: code ?? -1 }))
    },
    write: (data) => {
      if (child.stdin.writable) child.stdin.write(data.replace(/\r/g, '\n'))
    },
    kill: () => killGroup(child)
  }
}

function standInEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(dir, 'home'),
    [GROK_USAGE_BINARY_OVERRIDE_ENV]: join(dir, 'grok'),
    ...extra
  }
}

/**
 * The `grok-usage:probe` handler's own sequence (src/main/index.ts): resolve
 * the probe binary from the real environment, answer a null binary with the
 * no-data snapshot, and otherwise read `/usage` from the TUI.
 * GrokUsageBinaryOverride.test.ts pins that the handler keeps this shape.
 */
async function runUsageProbe(
  env: NodeJS.ProcessEnv,
  timing: { readyDelayMs: number; timeoutMs: number }
): Promise<{ source: string; snapshot: GrokUsageSnapshot }> {
  const resolved = await resolveGrokUsageProbeBinary({
    env,
    resolveDefault: async () => ({ binaryPath: null })
  })
  const binaryPath = resolved.binaryPath
  if (!binaryPath) return { source: resolved.source, snapshot: parseGrokUsage('', FIXED_NOW) }
  const snapshot = await probeGrokUsage({
    spawnPty: () => spawnPipeTerminal(binaryPath, env),
    now: () => FIXED_NOW,
    ...timing
  })
  return { source: resolved.source, snapshot }
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(process.platform === 'win32')('Grok usage probe against a signed-out CLI', () => {
  it.each([
    {
      opener: 'BROWSER',
      env: (): Record<string, string> => ({ BROWSER: join(dir, 'stubs', 'browser') })
    },
    { opener: 'open', env: (): Record<string, string> => ({}) }
  ])(
    'never launches the TUI of a CLI that reports it is signed out, so its login cannot reach $opener',
    async ({ env }) => {
      writeStandInGrok({ modelsAuthLine: 'You are not authenticated.', tui: 'begins-sign-in' })

      const { source, snapshot } = await runUsageProbe(standInEnv(env()), {
        readyDelayMs: 200,
        timeoutMs: 2500
      })

      expect(readIfPresent(join(dir, 'browser-opened'))).toBe('')
      expect(existsSync(join(dir, 'tui-started'))).toBe(false)
      // The CLI was asked, non-interactively, and said so both times.
      expect(readIfPresent(join(dir, 'models-args'))).toBe(
        '--no-auto-update models\n--no-auto-update models\n'
      )
      expect(source).toBe('signed_out')
      expect(snapshot.confidence).toBe('unavailable')
      expect(snapshot.creditsUsedDisplay).toBe('')
    },
    20_000
  )

  it('ends a TUI that begins signing in anyway, without typing /usage into it', async () => {
    // The CLI said it was signed in, then its TUI started a sign-in all the
    // same (a session that lapsed between the two calls). This stand-in waits
    // 1.2s before its browser, so an absent marker proves the TUI was ended.
    // The real CLI opens its browser about a tenth of a second after the
    // sign-in code arrives, usually before this screen reaches the probe:
    // only not launching a signed-out CLI keeps that browser shut.
    writeStandInGrok({
      modelsAuthLine: 'You are logged in with grok.com',
      tui: 'begins-sign-in',
      browserDelaySeconds: 1.2
    })

    const startedAt = Date.now()
    const { snapshot } = await runUsageProbe(
      standInEnv({ BROWSER: join(dir, 'stubs', 'browser') }),
      { readyDelayMs: 2000, timeoutMs: 3000 }
    )
    const settledAfterMs = Date.now() - startedAt
    // Stay past the stand-in's browser deadline, so an absent marker means the
    // TUI was ended rather than not yet due.
    await sleep(Math.max(0, 2000 - settledAfterMs))

    expect(existsSync(join(dir, 'tui-started'))).toBe(true)
    expect(readIfPresent(join(dir, 'browser-opened'))).toBe('')
    expect(settledAfterMs).toBeLessThan(1200)
    expect(readIfPresent(join(dir, 'tui-stdin'))).not.toContain('/usage')
    expect(snapshot.confidence).toBe('unavailable')
  }, 20_000)

  it('still reads /usage when the check itself renews an expired session', async () => {
    // Seen against grok 1.0.46: with an expired but renewable access token,
    // `grok models` prints "You are not authenticated.", renews the session
    // while it runs, and reports it signed in when asked again.
    writeStandInGrok({
      modelsAuthLine: 'You are not authenticated.',
      modelsAuthLineOnceRenewed: 'You are logged in with grok.com',
      tui: 'shows-usage'
    })

    const { source, snapshot } = await runUsageProbe(standInEnv(), {
      readyDelayMs: 200,
      timeoutMs: 4000
    })

    expect(source).toBe('override')
    expect(snapshot.confidence).toBe('observed')
    expect(snapshot.creditsUsedPercent).toBe(42)
  }, 20_000)

  it('still reads /usage from a CLI that reports it is signed in', async () => {
    writeStandInGrok({ modelsAuthLine: 'You are logged in with grok.com', tui: 'shows-usage' })

    const { source, snapshot } = await runUsageProbe(standInEnv(), {
      readyDelayMs: 200,
      timeoutMs: 4000
    })

    expect(source).toBe('override')
    expect(readIfPresent(join(dir, 'tui-stdin'))).toBe('/usage\n')
    expect(snapshot.confidence).toBe('observed')
    expect(snapshot.usageKind).toBe('weekly_limit')
    expect(snapshot.creditsUsedPercent).toBe(42)
    expect(snapshot.resetAtText).toBe('July 2, 09:04 PT')
  }, 20_000)
})
