/*
 * TailscaleAuth — guided "link this Mac to your tailnet" with an auth key.
 *
 * For users who already run a Tailscale fleet: instead of the interactive
 * browser sign-in, they paste an auth key (generated in the Tailscale admin
 * console) and we bring this node up non-interactively with `tailscale up`.
 *
 * Security stance (deliberate, and accurate):
 *   - The key is used ONCE and is NEVER persisted to app settings — no bearer
 *     credential at rest. After `up` succeeds the node has its own node key.
 *   - The key is kept OFF the process argv: it is written to a 0600 temp file
 *     and passed as `--auth-key=file:<path>`, so a same-user `ps` cannot read
 *     it from the command line. The file is removed immediately afterwards.
 *   - The key is NEVER logged or returned: any echo of it in CLI output is
 *     stripped before we surface a message.
 *   - `exec`/`prepareKeyFile` are injectable for tests; nothing here throws —
 *     failures come back as { ok: false, message } with the CLI's wording.
 *
 * Note on flags: `tailscale up` resets unspecified flags to their defaults, so
 * running it on an already-configured node would clobber its config. The
 * CALLER therefore gates this on "not already connected" (see the
 * ios-remote-tailscale-link handler) — here we keep flags minimal (no
 * --accept-routes/--reset/--ssh) precisely because we only run on a fresh node.
 */

import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { ServeExec } from './TailscaleServe'
import { looksLikeTailscaleAuthKey } from '../shared/tailscaleAuthKey'

export { looksLikeTailscaleAuthKey } from '../shared/tailscaleAuthKey'

const execFileAsync = promisify(execFile)

const defaultExec: ServeExec = async (cmd, args) => {
  // `tailscale up` can take a little while to register a fresh node.
  const result = await execFileAsync(cmd, args, { timeout: 40_000 })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}

export interface TailscaleAuthResult {
  ok: boolean
  /** CLI output (stderr preferred) with the auth key redacted. */
  message?: string
}

/** A short, safe label for diagnostics — never the whole key. */
export function redactAuthKey(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 12) return 'tskey-***'
  return `${trimmed.slice(0, 11)}…${trimmed.slice(-4)}`
}

/** Strip any verbatim occurrence of the key from CLI output. */
function stripAuthKey(text: string, authKey: string): string {
  if (!authKey) return text
  return text.split(authKey).join('tskey-…redacted')
}

export interface PreparedKeyFile {
  path: string
  cleanup: () => Promise<void>
}

/** Write the key to a private 0600 file so it never lands on the argv. */
const defaultPrepareKeyFile = async (authKey: string): Promise<PreparedKeyFile> => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-ts-authkey-'))
  const path = join(dir, 'key')
  await writeFile(path, authKey, { mode: 0o600 })
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

export async function tailscaleUpWithAuthKey(input: {
  cliPath: string
  authKey: string
  exec?: ServeExec
  prepareKeyFile?: (authKey: string) => Promise<PreparedKeyFile>
}): Promise<TailscaleAuthResult> {
  if (!input.cliPath) {
    return { ok: false, message: 'Tailscale CLI not found — install Tailscale first.' }
  }
  const authKey = input.authKey.trim()
  if (!looksLikeTailscaleAuthKey(authKey)) {
    return {
      ok: false,
      message: 'That does not look like a Tailscale auth key (expected a tskey-… value).'
    }
  }
  const exec = input.exec ?? defaultExec
  const prepare = input.prepareKeyFile ?? defaultPrepareKeyFile
  const { path, cleanup } = await prepare(authKey)
  try {
    const { stdout, stderr } = await exec(input.cliPath, [
      'up',
      `--auth-key=file:${path}`,
      '--timeout=30s'
    ])
    return { ok: true, message: stripAuthKey((stderr || stdout).trim(), authKey) || undefined }
  } catch (err) {
    const anyErr = err as Error & { stderr?: string; stdout?: string }
    const detail = (anyErr.stderr || anyErr.stdout || anyErr.message || String(err)).trim()
    return { ok: false, message: stripAuthKey(detail, authKey) || 'tailscale up failed.' }
  } finally {
    await cleanup()
  }
}
