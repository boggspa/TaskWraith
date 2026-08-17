// PreToolUse approval bridge for the official agy CLI.
//
// Official agy exposes exactly one per-tool seam: documented lifecycle hooks
// (`hooks.json` in the workspace customization root, e.g. `.agents/`). A
// PreToolUse hook receives each tool call as JSON on stdin and must print a
// decision object on stdout. This module builds the temporary named-hook
// overlay TaskWraith installs for a run, and the localhost server that turns
// each hook invocation into a real TaskWraith approval-gate decision — the
// same fast paths, tier holds, and approval cards every other provider gets.
//
// MEASURED 2026-08-06 against the shipped agy binary — agy has TWO independent
// layers and the hook is only one of them:
//
//   1. `permissions.allow` in settings.json decides what is POSSIBLE. In
//      headless print mode anything outside it is auto-denied with no prompt,
//      which kills the whole turn ("no output produced").
//   2. The PreToolUse hook can only VETO. Returning `{"decision":"allow"}` does
//      NOT satisfy layer 1 — a probe run with an allow-returning hook still
//      died on `write_file`. Do not "simplify" by dropping the settings lease.
//
// So the lease grants broadly for the run and this bridge is the real per-call
// gate. That inverts the failure posture: because the settings layer is open,
// a bridge that cannot answer must DENY, not defer. Hence the curl fallback
// emits a deny decision rather than `{}` — `{}` would hand the call back to an
// agy permission layer TaskWraith has deliberately opened.
//
// Fail-safe shape: bad token, malformed body, and gate throws DENY. Only an
// explicit `none` from the registered run handler defers to agy's native flow;
// otherwise `{}` could hand a call to the command(*) rule the lease installed.

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { APPROVAL_TRANSPORT_TIMEOUT_MS } from '../../shared/interactionTimeouts'

const HOOK_NAME = 'taskwraith-approval-bridge'
/** agy default is 30s; honor TaskWraith's full configurable approval ceiling. */
const HOOK_TIMEOUT_SECONDS = Math.ceil(APPROVAL_TRANSPORT_TIMEOUT_MS / 1000)
/** curl gives up before agy's own hook timeout so the fallback denial wins. */
const CURL_MAX_TIME_SECONDS = HOOK_TIMEOUT_SECONDS - 10
const MAX_REQUEST_BYTES = 512 * 1024
const TOKEN_HEX_RE = /^[0-9a-f]{32,128}$/

export interface AgyHookBridgeDecision {
  /** `none` responds `{}` — no decision, agy's native flow proceeds. */
  decision: 'allow' | 'deny' | 'none'
  reason?: string
}

export interface AgyHookToolCall {
  name: string
  command: string | null
  /** Mutation target, when the tool's args carry a recognisable path. */
  targetPath: string | null
  /**
   * AGY mutation arguments that can be used to derive diff stats.
   * Extracted from toolCall.args and decoded from AGY's JSON-quoted scalars.
   */
  oldString?: string
  newString?: string
  content?: string
  patch?: string
}

/**
 * Which approval gate a tool call belongs to.
 *
 * `other` defers to agy's native flow, which is also its own default — so an
 * unrecognised READ costs nothing. An unrecognised MUTATION is the expensive
 * mistake: it reaches agy's headless confirmation, gets soft-denied, and kills
 * the run with no assistant output. That is why the write test is a shape
 * heuristic over the name rather than a fixed list — agy is an auto-updating
 * external binary and its tool namespace is not ours to enumerate. Shipping a
 * matcher of exactly `run_command` is what let `Edit` through to that fate.
 */
export type AgyHookToolKind = 'shell' | 'write' | 'other'

const SHELL_TOOL_RE = /(?:^|_)(?:run_?)?(?:command|terminal|shell|bash)(?:$|_)/i
const WRITE_TOOL_RE = /(?:write|edit|create|replace|delete|remove|rename|move|patch|insert)/i
/** Read-side names that would otherwise trip the write heuristic. */
const READ_TOOL_RE = /^(?:read|view_file|list_dir|list_directory|.*search.*|grep.*)$/i

export function classifyAgyHookTool(name: string): AgyHookToolKind {
  const trimmed = String(name || '').trim()
  if (!trimmed) return 'other'
  if (SHELL_TOOL_RE.test(trimmed)) return 'shell'
  if (READ_TOOL_RE.test(trimmed)) return 'other'
  return WRITE_TOOL_RE.test(trimmed) ? 'write' : 'other'
}

/**
 * agy spells the mutation target differently per tool (`TargetFile` on Edit,
 * `file_path` on write_file, plain `path` elsewhere), so every observed
 * spelling is accepted. A missing path never blocks arbitration — the gate
 * still runs, it just names the tool instead of the file.
 */
const TARGET_PATH_KEYS = [
  'TargetFile',
  'target_file',
  'AbsolutePath',
  'absolute_path',
  'FilePath',
  'file_path',
  'filePath',
  'Path',
  'path'
]

/**
 * AGY mutation argument keys that carry diff-relevant content.
 * These are extracted and forwarded so bridgeToolDiffStats can derive +N/-N chips.
 */
const MUTATION_ARG_KEYS: ReadonlyArray<{
  key: string
  canonical: keyof Pick<AgyHookToolCall, 'oldString' | 'newString' | 'content' | 'patch'>
}> = [
  { key: 'OldString', canonical: 'oldString' },
  { key: 'old_string', canonical: 'oldString' },
  { key: 'Old', canonical: 'oldString' },
  { key: 'NewString', canonical: 'newString' },
  { key: 'new_string', canonical: 'newString' },
  { key: 'New', canonical: 'newString' },
  { key: 'CodeEdit', canonical: 'content' },
  { key: 'content', canonical: 'content' },
  { key: 'file_text', canonical: 'content' },
  { key: 'Content', canonical: 'content' },
  { key: 'FileText', canonical: 'content' },
  { key: 'Patch', canonical: 'patch' },
  { key: 'patch', canonical: 'patch' },
  { key: 'diff', canonical: 'patch' }
]

/**
 * agy 1.1.12 started encoding scalar tool args as JSON string literals inside
 * the already-JSON hook payload (`CommandLine: '"git status"'`). Decode exactly
 * one such layer before policy classification. If the value is not a valid
 * JSON string literal, preserve it byte-for-byte so the downstream command
 * classifier fails closed instead of repairing attacker-controlled syntax.
 */
function decodeAgyHookScalar(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed)
      if (typeof decoded === 'string') return decoded
    } catch {
      // Keep the original value; policy classifiers will reject bad quoting.
    }
  }
  return value
}

export function createAgyHookBridgeToken(): string {
  return randomBytes(24).toString('hex')
}

/**
 * The named-hook object merged into the workspace `hooks.json`. The command is
 * assembled only from a validated port and hex token, so no caller-controlled
 * text can reach the shell line agy executes. `|| printf {}` keeps every curl
 * failure (bridge gone, timeout, refused) on the no-decision path.
 */
export function buildAgyHookBridgeNamedHook(input: { port: number; token: string }): {
  hookName: string
  namedHook: Record<string, unknown>
} {
  const port = input.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The agy hook bridge requires a valid localhost port.')
  }
  if (!TOKEN_HEX_RE.test(input.token)) {
    throw new Error('The agy hook bridge requires a lowercase-hex session token.')
  }
  // Single-quoted JSON with no interpolation: the only variable parts are a
  // validated integer port and a hex token, so nothing caller-controlled
  // reaches the shell line.
  const unreachableDecision = `{"decision":"deny","reason":"The TaskWraith approval bridge did not answer, so this call cannot be arbitrated. It was denied rather than run unreviewed; retry, or continue with read-only inspection."}`
  const command = `/usr/bin/curl -sS --max-time ${CURL_MAX_TIME_SECONDS} -X POST -H 'Content-Type: application/json' -H 'X-TaskWraith-Hook-Token: ${input.token}' --data-binary @- http://127.0.0.1:${port}/agy/pretooluse || printf '${unreachableDecision}'`
  return {
    hookName: HOOK_NAME,
    namedHook: {
      PreToolUse: [
        {
          // agy treats `matcher` as a REGEX (its loader reports "Invalid
          // matcher regex" on a bad one), so `.*` subscribes to every tool and
          // the handler decides. Deliberately not an allowlist of names: agy
          // auto-updates, and a name this build has never heard of would
          // bypass the bridge and hit the fatal headless soft-deny instead.
          matcher: '.*',
          hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }]
        }
      ]
    }
  }
}

function extractToolCall(body: unknown): AgyHookToolCall | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const toolCall = (body as { toolCall?: unknown }).toolCall
  if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) return null
  const name = decodeAgyHookScalar((toolCall as { name?: unknown }).name)
  if (!name) return null
  const args = (toolCall as { args?: unknown }).args
  const argRecord =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : null
  const commandLine = decodeAgyHookScalar(argRecord?.CommandLine)
  let targetPath: string | null = null
  for (const key of TARGET_PATH_KEYS) {
    const value = decodeAgyHookScalar(argRecord?.[key])
    if (value?.trim()) {
      targetPath = value
      break
    }
  }
  // Extract mutation args for diff stat derivation
  const mutationArgs: Partial<Pick<AgyHookToolCall, 'oldString' | 'newString' | 'content' | 'patch'>> =
    {}
  for (const { key, canonical } of MUTATION_ARG_KEYS) {
    const value = decodeAgyHookScalar(argRecord?.[key])
    if (value !== null && value !== undefined && !mutationArgs[canonical]) {
      mutationArgs[canonical] = value
    }
  }
  return {
    name,
    command: commandLine,
    targetPath,
    ...mutationArgs
  }
}

export interface AgyHookBridgeServer {
  port: number
  /** Register a run's token; returns the matching unregister. */
  registerRun(
    token: string,
    decide: (toolCall: AgyHookToolCall) => Promise<AgyHookBridgeDecision>
  ): () => void
  close(): Promise<void>
}

/**
 * One loopback server for the app lifetime; runs register per-launch tokens.
 * Responses are ALWAYS 200 with a JSON body, because the hook prints the
 * response body verbatim to stdout — a non-decision must still be valid JSON.
 */
export async function startAgyHookBridgeServer(): Promise<AgyHookBridgeServer> {
  const runs = new Map<string, (toolCall: AgyHookToolCall) => Promise<AgyHookBridgeDecision>>()

  const server: Server = createServer((request, response) => {
    const respond = (payload: Record<string, unknown>): void => {
      const text = JSON.stringify(payload)
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text)
      })
      response.end(text)
    }
    const denyBridgeFailure = (): void => {
      respond({
        decision: 'deny',
        reason:
          'The TaskWraith approval bridge could not validate this tool call, so it was denied rather than run outside the signed permission posture.'
      })
    }

    if (request.method !== 'POST' || request.url !== '/agy/pretooluse') {
      denyBridgeFailure()
      return
    }
    const token = request.headers['x-taskwraith-hook-token']
    const decide = typeof token === 'string' ? runs.get(token) : undefined
    if (!decide) {
      denyBridgeFailure()
      return
    }

    const chunks: Buffer[] = []
    let received = 0
    let overflowed = false
    request.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_REQUEST_BYTES) {
        overflowed = true
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', () => {
      if (!response.writableEnded) denyBridgeFailure()
    })
    request.on('end', () => {
      if (overflowed) {
        denyBridgeFailure()
        return
      }
      let toolCall: AgyHookToolCall | null = null
      try {
        toolCall = extractToolCall(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        toolCall = null
      }
      if (!toolCall) {
        denyBridgeFailure()
        return
      }
      decide(toolCall).then(
        (decision) =>
          respond(
            decision.decision === 'deny'
              ? { decision: 'deny', ...(decision.reason ? { reason: decision.reason } : {}) }
              : decision.decision === 'allow'
                ? { decision: 'allow' }
                : {}
          ),
        denyBridgeFailure
      )
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address !== 'object') {
    server.close()
    throw new Error('The agy hook bridge could not bind a loopback port.')
  }

  return {
    port: address.port,
    registerRun(token, decide) {
      if (!TOKEN_HEX_RE.test(token)) {
        throw new Error('The agy hook bridge requires a lowercase-hex session token.')
      }
      if (runs.has(token)) {
        throw new Error('The agy hook bridge token is already registered.')
      }
      runs.set(token, decide)
      return () => {
        runs.delete(token)
      }
    },
    close() {
      runs.clear()
      return new Promise((resolveClose) => {
        server.close(() => resolveClose())
      })
    }
  }
}
