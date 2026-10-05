import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { stripGrokAnsi } from './GrokUsage'

// Whether the grok CLI is signed in, asked of the CLI itself.
//
// The usage probe drives the interactive TUI, and a TUI that holds no usable
// credential starts the CLI's own sign-in as soon as it launches ("auto-
// triggering login at startup" in grok's log): it fetches a device code and
// opens the default browser about a tenth of a second later, whatever the
// probe types. On macOS that browser launch goes through AppKit's NSWorkspace
// and reads no environment variable, so neither BROWSER nor an `open` on PATH
// can stop it. The only safe course is not to launch the TUI when the CLI is
// signed out.
//
// `grok models` answers that without starting anything: it is non-interactive,
// prints the CLI's auth status as its first line and exits, and it starts no
// sign-in even with an external auth provider configured. The CLI reads its own
// credential store to answer; TaskWraith reads no credential file and sends no
// prompt.

export type GrokCliSignInState = 'signed_in' | 'signed_out' | 'unknown'

export const GROK_SIGN_IN_CHECK_ARGS: readonly string[] = ['--no-auto-update', 'models']

/** `grok models` answers in about half a second when signed out. */
export const GROK_SIGN_IN_CHECK_TIMEOUT_MS = 8_000

const MAX_CAPTURED_CHARS = 64 * 1024

// The status line `grok models` (1.0.46) prints first, in each wording it has.
const SIGNED_OUT_LINE = /\bYou\s+are\s+not\s+authenticated\b/i
const SIGNED_IN_LINES = [
  /\bYou\s+are\s+logged\s+in\s+with\b/i,
  /\bYou\s+are\s+using\s+XAI_API_KEY\b/i,
  /\bYou\s+are\s+authenticated\s+via\b/i,
  /\bis\s+using\s+its\s+own\s+API\s+key\b/i
]

export function classifyGrokSignInOutput(output: string): GrokCliSignInState {
  const text = stripGrokAnsi(output)
  if (SIGNED_OUT_LINE.test(text)) return 'signed_out'
  return SIGNED_IN_LINES.some((line) => line.test(text)) ? 'signed_in' : 'unknown'
}

export interface GrokSignInCheckOptions {
  binaryPath: string
  /** The environment the probe launches the TUI with, so both see the same grok home. */
  env: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
}

/**
 * Run `grok --no-auto-update models` and read its status line. Never rejects:
 * a CLI that cannot be started, does not answer within the timeout (it is then
 * killed), or prints no status line it recognises yields 'unknown'.
 *
 * A first "not authenticated" is checked once more. The CLI reports the
 * credential it started with but renews an expired session while it runs
 * (its log shows `has_current: false`, then `auth: silent refresh` Renewed),
 * so a signed-in user whose access token had lapsed reads as signed out once
 * and as signed in on the second asking.
 */
export async function readGrokCliSignInState(
  options: GrokSignInCheckOptions
): Promise<GrokCliSignInState> {
  const first = await askGrokCli(options)
  return first === 'signed_out' ? askGrokCli(options) : first
}

function askGrokCli(options: GrokSignInCheckOptions): Promise<GrokCliSignInState> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let child: ChildProcess
    try {
      child = spawn(options.binaryPath, [...GROK_SIGN_IN_CHECK_ARGS], {
        // Out of any workspace, like the TUI probe's throwaway cwd.
        cwd: tmpdir(),
        env: { ...options.env, NO_COLOR: '1' },
        // No stdin: nothing here may ever wait on a terminal.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch {
      resolve('unknown')
      return
    }
    const finish = (state: GrokCliSignInState): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(state)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish('unknown')
    }, options.timeoutMs ?? GROK_SIGN_IN_CHECK_TIMEOUT_MS)
    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_CAPTURED_CHARS) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => finish('unknown'))
    child.on('close', () => finish(classifyGrokSignInOutput(output)))
  })
}
