/*
 * TailscaleAuth — guided "link this Mac to your tailnet" with an auth key.
 *
 * For users who already run a Tailscale fleet: instead of the interactive
 * browser sign-in, they paste an auth key (generated in the Tailscale admin
 * console) and we bring this node up non-interactively with
 * `tailscale up --auth-key=<key>`.
 *
 * Security stance (deliberate):
 *   - The key is used ONCE and is NEVER persisted — no bearer credential at
 *     rest. After `up` succeeds the node has its own node key and stays
 *     connected without it.
 *   - The key is passed as a single execFile ARG (no shell), so it cannot be
 *     word-split, globbed, or injected regardless of its contents.
 *   - The key is NEVER returned to the renderer or logged: any echo of it in
 *     the CLI's own output is stripped before we surface a message.
 *   - `exec` is injectable for tests; nothing here throws — failures come back
 *     as { ok: false, message } with the CLI's wording (it has good errors).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ServeExec } from './TailscaleServe'

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

/** Every Tailscale key (auth, OAuth client, API) is a `tskey-…` value. */
export function looksLikeTailscaleAuthKey(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('tskey-') && trimmed.length >= 16
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

/**
 * Bring this Mac onto the user's tailnet with an auth key. Minimal flags by
 * design — just `up --auth-key=<key>` with a bounded `--timeout` so it can't
 * hang; no `--accept-routes`/`--reset`/etc that would change the node's
 * routing or clobber the user's existing config.
 */
export async function tailscaleUpWithAuthKey(input: {
  cliPath: string
  authKey: string
  exec?: ServeExec
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
  try {
    const { stdout, stderr } = await exec(input.cliPath, [
      'up',
      `--auth-key=${authKey}`,
      '--timeout=30s'
    ])
    return { ok: true, message: stripAuthKey((stderr || stdout).trim(), authKey) || undefined }
  } catch (err) {
    const anyErr = err as Error & { stderr?: string; stdout?: string }
    const detail = (anyErr.stderr || anyErr.stdout || anyErr.message || String(err)).trim()
    return { ok: false, message: stripAuthKey(detail, authKey) || 'tailscale up failed.' }
  }
}
